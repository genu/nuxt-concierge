import { consola } from 'consola'
import { decodePayload, encodePayload } from '../envelope'
import { nextFireTime } from '../cron'
import type { MemoryOptions } from '../../../options'
import type { ActiveJob, BackoffOptions, JobHandler, WorkerRecord } from '../types'
import type { ConciergeDriver, Consumer, DedupOptions, EnqueueOptions, JobDetail, JobState, JobSummary, ScheduleSpec } from './types'

/** Exported so tests can spy on it instead of asserting on console output. */
export const logger = consola.create({}).withTag('nuxt-concierge')

const POLL_MS = 10

interface QueuedJob {
  id: string
  name: string
  queue: string
  envelope: { v: number, payload: string }
  attempt: number
  runAt: number
  /** TOTAL attempts including the first. `undefined` means one attempt. */
  attempts?: number
  backoff?: BackoffOptions
  createdAt: number
  dedup?: DedupOptions
  /** Present only when this job was produced by the driver's own scheduler. */
  cron?: { tick: number, expression: string, tz: string }
}

/**
 * Mirrors BullMQ's built-in strategies exactly
 * (`bullmq/dist/esm/classes/backoffs.js`): `fixed` returns the delay
 * unchanged, `exponential` returns `Math.round(2 ** (k - 1) * delay)` for the
 * k-th retry, so the first retry waits exactly `delay`.
 *
 * The index was OBSERVED against real Redis, not read off the source —
 * `attemptsMade` is mutated across several call sites and a Lua script.
 * Probed with attempts=4, backoff delay=200: gaps came back ~226/411/824ms,
 * confirming retry k waits `2 ** (k - 1) * delay` (not `2 ** k`). See the
 * retry-backoff probe recorded in specs/2026-08-13-spec3-decisions.md.
 *
 * Exported so the formula is testable without a scheduler, and so the shared
 * conformance table can assert on it directly.
 */
export const backoffDelay = (
  backoff: BackoffOptions | undefined,
  retryIndex: number,
): number => {
  if (!backoff) return 0
  if (backoff.type === 'fixed') return backoff.delay
  return Math.round(2 ** (retryIndex - 1) * backoff.delay)
}

/** Mirrors moduleDefaults.memory in src/options.ts. */
const MEMORY_DEFAULTS: MemoryOptions = { historyLimit: 100 }

export const resolveMemoryOptions = (opts?: Partial<MemoryOptions>): MemoryOptions => ({
  historyLimit: opts?.historyLimit ?? MEMORY_DEFAULTS.historyLimit,
})

/**
 * A finished job, retained so the dashboard has something to show. Holds the
 * ENVELOPE, not a decoded payload: decoding is the API layer's job (see
 * JobDetail.envelope), and retaining the envelope is also what lets
 * `introspect.retry` re-enqueue the original bytes rather than a re-encoded
 * round trip.
 */
interface TerminalRecord {
  id: string
  name: string
  queue: string
  state: 'completed' | 'failed'
  envelope: { v: number, payload: string }
  attemptsMade: number
  attempts?: number
  backoff?: BackoffOptions
  createdAt: number
  finishedAt: number
  failedReason?: string
  stack?: string
  dedupId?: string
}

/**
 * In-process queue with a real claim loop so delays, retries and concurrency
 * behave like the persistent driver. Loses everything on process death — that
 * is acceptable for a dev/test driver and is stated loudly in the docs.
 */
export const createMemoryDriver = (opts?: Partial<MemoryOptions>): ConciergeDriver => {
  const { historyLimit } = resolveMemoryOptions(opts)
  const pending = new Map<string, QueuedJob[]>()
  const handlers = new Map<string, JobHandler>()
  const records = new Map<string, { record: WorkerRecord, expiresAt: number }>()
  const consumers: Consumer[] = []
  /**
   * Terminal records per queue, oldest first. An array rather than a Map
   * because eviction is positional (oldest-first) and the sizes involved are
   * ~100 — a linear scan in `get` is cheaper than maintaining a second index
   * that a `shift()` could desynchronise.
   */
  const history = new Map<string, TerminalRecord[]>()
  /** Live jobs by id, for `counts`/`list`/`get` of non-terminal states. */
  const inFlight = new Map<string, ActiveJob>()
  let counter = 0

  const key = (queue: string, name: string) => `${queue}::${name}`
  const queueOf = (queue: string) => {
    if (!pending.has(queue)) pending.set(queue, [])
    return pending.get(queue)!
  }

  const historyOf = (queue: string) => {
    if (!history.has(queue)) history.set(queue, [])
    return history.get(queue)!
  }

  /**
   * Dedup keys, scoped by queue exactly as BullMQ's are (its key is
   * `<prefix>:<queue>:de:<id>`), so the same id on two queues does not
   * collide.
   *
   * `expiresAt` is checked LAZILY on read rather than with a timer per key. A
   * timer per key is a leak the driver would have to track and tear down, for
   * no benefit in a driver whose entire lifetime is bounded by the process.
   */
  const dedupKeys = new Map<string, { jobId: string, expiresAt?: number }>()

  const dedupKey = (queue: string, id: string) => `${queue}::${id}`

  const liveDedup = (queue: string, id: string) => {
    const entry = dedupKeys.get(dedupKey(queue, id))
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      dedupKeys.delete(dedupKey(queue, id))
      return undefined
    }
    return entry
  }

  /**
   * Mirrors `removeDeduplicationKeyIfNeededOnFinalization` in
   * bullmq/dist/esm/scripts/moveToFinished-14.js: a key with NO expiry is
   * deleted when the job finalizes; a key WITH one is left to expire. That
   * asymmetry is the whole difference between lock mode and throttle mode, and
   * `memory` has to reproduce it exactly or the two drivers disagree about
   * which enqueues are suppressed.
   *
   * The `jobId` guard mirrors BullMQ's `currentJobId == jobId` check: a key
   * already re-taken by a newer job must not be released by an older one
   * finishing.
   */
  const releaseDedupOnFinalize = (queue: string, id: string | undefined, jobId: string) => {
    if (!id) return
    const k = dedupKey(queue, id)
    const entry = dedupKeys.get(k)
    if (!entry || entry.expiresAt !== undefined) return
    if (entry.jobId === jobId) dedupKeys.delete(k)
  }

  const buildQueuedJob = (id: string, queue: string, job: EnqueueOptions): QueuedJob => ({
    id,
    name: job.name,
    queue,
    envelope: encodePayload(job.payload),
    attempt: 0,
    runAt: Date.now() + (job.delay ?? 0),
    attempts: job.attempts,
    backoff: job.backoff,
    createdAt: Date.now(),
    dedup: job.dedup,
    cron: job.cron,
  })

  const remember = (record: TerminalRecord) => {
    const bucket = historyOf(record.queue)
    bucket.push(record)
    // Oldest-first eviction. A `while` rather than a single `shift()` so a
    // lowered historyLimit converges instead of leaking one record per call.
    // `bucket.length > 0` is a defensive second bound, not the primary fix:
    // `resolveModuleOptions` validates `historyLimit` as a positive integer at
    // boot, so this branch should be unreachable in practice. It exists
    // because `shift()` on an empty array leaves `length` at 0, and a
    // negative `historyLimit` sneaking in some other way (a direct
    // `createMemoryDriver({ historyLimit: -1 })` call bypassing the
    // module-option resolver, e.g. in a test) would otherwise spin forever:
    // `0 > -1` never becomes false.
    while (bucket.length > historyLimit && bucket.length > 0) bucket.shift()
  }

  const toDetail = (record: TerminalRecord): JobDetail => ({
    id: record.id,
    name: record.name,
    queue: record.queue,
    state: record.state,
    attemptsMade: record.attemptsMade,
    attempts: record.attempts,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt || undefined,
    failedReason: record.failedReason,
    stack: record.stack,
    envelope: record.envelope,
    deduplicationId: record.dedupId,
  })

  /**
   * Projects to EXACTLY `JobSummary`'s fields — never `toDetail`/`JobDetail`.
   * `JobDetail extends JobSummary`, so passing a `TerminalRecord` through
   * `toDetail` here would type-check (a wider object satisfies the narrower
   * declared return type on assignment) while actually putting `envelope`
   * (raw devalue payload content) and `stack` on the wire for every row in a
   * list response, not just the one row a caller opens via `get()`. `get()`
   * returning the raw envelope is its contract; `list()`'s is `JobSummary`,
   * which has neither field, and the shared conformance table asserts this
   * directly (`introspection-conformance.test.ts`).
   */
  const toSummary = (record: TerminalRecord): JobSummary => ({
    id: record.id,
    name: record.name,
    queue: record.queue,
    state: record.state,
    attemptsMade: record.attemptsMade,
    attempts: record.attempts,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt || undefined,
    failedReason: record.failedReason,
  })

  const listByState = (queue: string, state: JobState): JobSummary[] => {
    const now = Date.now()
    if (state === 'completed' || state === 'failed') {
      return historyOf(queue)
        .filter(r => r.state === state)
        .map(r => toSummary(r))
    }
    if (state === 'active') {
      return [...inFlight.values()]
        .filter(j => j.queue === queue)
        .map(j => ({
          id: j.jobId,
          name: j.name,
          queue,
          state: 'active' as const,
          attemptsMade: 0,
          createdAt: j.startedAt,
        }))
    }
    return queueOf(queue)
      .filter(j => (state === 'waiting' ? j.runAt <= now : j.runAt > now))
      .map(j => ({
        id: j.id,
        name: j.name,
        queue,
        state,
        attemptsMade: j.attempt,
        attempts: j.attempts,
        createdAt: j.createdAt,
      }))
  }

  interface ScheduleEntry {
    spec: ScheduleSpec
    queue: string
    next: number
    iterationCount: number
    timer?: ReturnType<typeof setTimeout>
  }

  const schedules = new Map<string, ScheduleEntry>()
  const scheduleKey = (queue: string, id: string) => `${queue}::${id}`

  /**
   * Node/V8 timer delays are a 32-bit signed int internally
   * (`TimeoutOverflowWarning`): a `setTimeout` asked for longer than this is
   * silently clamped to fire almost immediately instead of throwing. A
   * monthly cron (up to 31 days) already exceeds it, and yearly comfortably
   * does — without the chunking below, `arm` would fire such a schedule
   * within ~1ms of being armed and then keep re-firing in a tight loop
   * instead of waiting for the real next tick.
   */
  const MAX_TIMEOUT_MS = 2_147_483_647

  /**
   * Arms one timer for the NEXT tick only, re-arming after each fire — never a
   * setInterval. A cron expression's gaps are not uniform (month lengths, DST),
   * so an interval would drift; and one live timer per schedule is what makes
   * `close()` able to stop everything deterministically.
   */
  const arm = (key: string) => {
    const entry = schedules.get(key)
    if (!entry) return

    const delay = Math.max(0, entry.next - Date.now())

    if (delay > MAX_TIMEOUT_MS) {
      // Wait out the largest safe chunk and re-arm, without firing anything
      // or consuming the tick — this only shortens the remaining wait.
      entry.timer = setTimeout(() => arm(key), MAX_TIMEOUT_MS)
      entry.timer.unref?.()
      return
    }

    entry.timer = setTimeout(() => {
      const current = schedules.get(key)
      if (!current) return

      void driverSelf.enqueue(current.queue, {
        name: current.spec.jobName,
        payload: current.spec.payload,
        // Resolved by reconcileSchedules against concierge.defaults — without
        // forwarding these, a scheduler-produced job fell back to this
        // driver's own bare "undefined attempts means one attempt" default,
        // silently discarding the job's own retry policy on every tick.
        attempts: current.spec.attempts,
        backoff: current.spec.backoff,
        cron: {
          // The SCHEDULED time, not Date.now(). They differ by timer latency,
          // and only the scheduled time is stable across a retry of this tick.
          tick: current.next,
          expression: current.spec.expression,
          tz: current.spec.tz,
        },
      })

      current.iterationCount++
      current.next = nextFireTime(current.spec.expression, current.spec.tz, current.next)
      arm(key)
    }, delay)
    // Never holds the process open on its own — only real work should. Matches
    // how the supervisor's heartbeat interval is handled.
    entry.timer.unref?.()
  }

  const disarm = (entry: ScheduleEntry) => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
  }

  const driverSelf: ConciergeDriver = {
    name: 'memory',
    capabilities: { persistent: false, crossProcess: false, history: 'bounded' },

    introspect: {
      counts: async (queue) => {
        const now = Date.now()
        const q = queueOf(queue)
        const terminal = historyOf(queue)
        return {
          waiting: q.filter(j => j.runAt <= now).length,
          delayed: q.filter(j => j.runAt > now).length,
          active: [...inFlight.values()].filter(j => j.queue === queue).length,
          completed: terminal.filter(r => r.state === 'completed').length,
          failed: terminal.filter(r => r.state === 'failed').length,
        }
      },

      list: async (queue, state, page) => {
        const all = listByState(queue, state)
        return {
          items: all.slice(page.offset, page.offset + page.limit),
          // `total` is the FULL count, not the page length. The UI's paging
          // control reads it; returning items.length would make every page
          // look like the last one.
          total: all.length,
        }
      },

      get: async (queue, id) => {
        const terminal = historyOf(queue).find(r => r.id === id)
        if (terminal) return toDetail(terminal)

        const queued = queueOf(queue).find(j => j.id === id)
        if (queued) {
          // State computed from runAt, NOT inherited from a shared record
          // shape. An earlier draft of this plan routed a queued job through a
          // `TerminalRecord` whose `state` field defaulted to 'completed',
          // which would have reported every waiting job as completed — a job
          // visible in the waiting list and simultaneously claiming to have
          // finished.
          return {
            id: queued.id,
            name: queued.name,
            queue,
            state: queued.runAt <= Date.now() ? 'waiting' : 'delayed',
            attemptsMade: queued.attempt,
            attempts: queued.attempts,
            createdAt: queued.createdAt,
            envelope: queued.envelope,
            deduplicationId: queued.dedup?.id,
          }
        }

        const running = inFlight.get(id)
        if (running && running.queue === queue) {
          const q = queueOf(queue).find(j => j.id === id)
          // An active job is no longer in `pending` (the loop spliced it out),
          // so there is no envelope to show. Reported as `active` with an
          // undefined envelope rather than omitted, so the UI can render "this
          // job is running" instead of "not found".
          return {
            id,
            name: running.name,
            queue,
            state: 'active',
            attemptsMade: q?.attempt ?? 0,
            createdAt: running.startedAt,
            envelope: undefined,
          }
        }

        return undefined
      },

      retry: async (queue, id) => {
        const bucket = historyOf(queue)
        const idx = bucket.findIndex(r => r.id === id && r.state === 'failed')
        if (idx === -1) {
          throw new Error(
            `[nuxt-concierge] no failed job "${id}" on queue "${queue}" to retry. `
            + `The memory driver retains ${historyLimit} terminal records per queue, `
            + `oldest evicted first, so it may already have been dropped.`,
          )
        }

        // Removed from history as it is re-queued: leaving it would show the
        // job as both failed and waiting, and a second click would enqueue a
        // third copy.
        const [record] = bucket.splice(idx, 1)
        queueOf(queue).push({
          id: record!.id,
          name: record!.name,
          queue,
          envelope: record!.envelope,
          // PRESERVED, not reset. BullMQ's `job.retry()` (installed version
          // 5.63.0, `retry(state?: FinishedStatus)`, no options and no
          // `resetAttemptsMade`) does not reset `attemptsMade` either — an
          // exhausted job moved back to waiting runs the handler exactly ONE
          // more time and then dead-letters again, rather than getting a full
          // fresh allowance. Resetting to 0 here used to give `memory` up to
          // `attempts` fresh runs on the very case where `bullmq` allows only
          // one, which is invisible in the shared conformance table's
          // `attempts: 1` case (both drivers coincidentally produce 2 total
          // runs there) and only shows up at `attempts: 3`, the actual
          // default. See the `attempts: 3` case in
          // introspection-conformance.test.ts and `DriverIntrospection.retry`
          // in drivers/types.ts.
          attempt: record!.attemptsMade,
          runAt: Date.now(),
          attempts: record!.attempts,
          backoff: record!.backoff,
          createdAt: record!.createdAt,
        })
      },
    },

    schedule: {
      upsert: async (queue, spec) => {
        const scheduleId = scheduleKey(queue, spec.id)
        const existing = schedules.get(scheduleId)
        // Update IN PLACE rather than remove-then-add: a remove-then-add would
        // open a window in which the schedule does not exist, and would reset
        // iterationCount on every boot of every instance.
        if (existing) disarm(existing)

        schedules.set(scheduleId, {
          spec,
          queue,
          next: nextFireTime(spec.expression, spec.tz, Date.now()),
          iterationCount: existing?.iterationCount ?? 0,
        })
        arm(scheduleId)
      },

      list: async queue => [...schedules.values()]
        .filter(e => e.queue === queue)
        .map(e => ({
          id: e.spec.id,
          jobName: e.spec.jobName,
          queue: e.queue,
          expression: e.spec.expression,
          tz: e.spec.tz,
          next: e.next,
          iterationCount: e.iterationCount,
        })),

      remove: async (queue, id) => {
        const scheduleId = scheduleKey(queue, id)
        const entry = schedules.get(scheduleId)
        if (entry) disarm(entry)
        schedules.delete(scheduleId)
      },
    },

    init: async () => {},
    isHealthy: () => true,

    close: async (force) => {
      await Promise.all(consumers.splice(0).map(c => c.close(force)))
      for (const entry of schedules.values()) disarm(entry)
      schedules.clear()
      pending.clear()
      history.clear()
      inFlight.clear()
      dedupKeys.clear()
    },

    registerHandler: (queue, name, handler) => {
      handlers.set(key(queue, name), handler)
    },

    enqueue: async (queue, job) => {
      if (job.dedup) {
        const k = dedupKey(queue, job.dedup.id)
        const existing = liveDedup(queue, job.dedup.id)

        if (existing) {
          if (job.dedup.replace) {
            // DEBOUNCE. Supersede the pending job so the burst collapses onto
            // the LAST payload, and re-arm the window when `extend` is set.
            // Only a job still in the `pending` array (waiting OR delayed) can
            // be replaced — one already claimed by the poll loop (active) or
            // finished is not "pending" in any sense BullMQ's own
            // removeDelayedJob would recognise.
            const q = queueOf(queue)
            const idx = q.findIndex(j => j.id === existing.jobId)
            if (idx !== -1) {
              q.splice(idx, 1)
              const id = `mem-${++counter}`
              q.push(buildQueuedJob(id, queue, job))
              dedupKeys.set(k, {
                jobId: id,
                expiresAt: job.dedup.extend && job.dedup.ttl !== undefined
                  ? Date.now() + job.dedup.ttl
                  : existing.expiresAt,
              })
              return { id, deduplicated: false }
            }
            // Nothing to supersede — the target was already claimed by the
            // poll loop or has finished. This enqueue is simply suppressed, so
            // fall through to the shared re-arm below rather than returning
            // early.
          }

          // Applies to EVERY suppressed enqueue, replace or not. Hoisted out
          // of the replace branch deliberately: a `{ extend, replace }`
          // debounce whose target had already gone active used to fall past
          // this and let the window lapse, so a burst against a long-running
          // job silently produced a second run — the exact failure debounce
          // exists to prevent.
          if (job.dedup.extend && job.dedup.ttl !== undefined) {
            dedupKeys.set(k, { jobId: existing.jobId, expiresAt: Date.now() + job.dedup.ttl })
          }

          return { id: existing.jobId, deduplicated: true }
        }

        const id = `mem-${++counter}`
        queueOf(queue).push(buildQueuedJob(id, queue, job))
        dedupKeys.set(k, {
          jobId: id,
          expiresAt: job.dedup.ttl !== undefined ? Date.now() + job.dedup.ttl : undefined,
        })
        return { id, deduplicated: false }
      }

      const id = `mem-${++counter}`
      queueOf(queue).push(buildQueuedJob(id, queue, job))
      return { id, deduplicated: false }
    },

    consume: (queue, opts, onJob): Consumer => {
      const active = new Map<string, ActiveJob>()
      let paused = false
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const resolveHandler = (name: string): JobHandler | undefined =>
        onJob ?? handlers.get(key(queue, name))

      const run = async (job: QueuedJob) => {
        active.set(job.id, { jobId: job.id, queue, name: job.name, startedAt: Date.now() })
        inFlight.set(job.id, { jobId: job.id, queue, name: job.name, startedAt: Date.now() })
        try {
          const handler = resolveHandler(job.name)
          if (!handler) throw new Error(`[nuxt-concierge] no handler for "${job.name}" on "${queue}"`)

          await handler({
            id: job.id,
            name: job.name,
            queue,
            attempt: job.attempt,
            payload: decodePayload(job.envelope),
            cron: job.cron,
          })

          releaseDedupOnFinalize(queue, job.dedup?.id, job.id)
          remember({
            id: job.id,
            name: job.name,
            queue,
            state: 'completed',
            envelope: job.envelope,
            attemptsMade: job.attempt,
            attempts: job.attempts,
            backoff: job.backoff,
            createdAt: job.createdAt,
            finishedAt: Date.now(),
            dedupId: job.dedup?.id,
          })
        }
        catch (error) {
          // `run` is invoked as `void run(job)` (fire-and-forget), so a
          // TypeError thrown HERE (reading `.retryable` off a thrown `null`/
          // `undefined`/primitive) becomes an unhandled rejection that can
          // take the whole process down, with the job neither retried nor
          // logged. Guard the shape before reading the property.
          const permanent = typeof error === 'object' && error !== null
            && (error as { retryable?: boolean }).retryable === false

          // `attempts` is TOTAL attempts including the first, matching
          // BullMQ. `job.attempt` was already incremented before `run`, so it
          // is the number of attempts MADE. An absent `attempts` means one
          // attempt — never a hardcoded ceiling: this used to be
          // MAX_ATTEMPTS = 3 while bullmq passed nothing and therefore never
          // retried at all, so a flaky job passed here and dead-lettered on
          // first failure in production.
          const totalAttempts = job.attempts ?? 1
          const willRetry = !permanent && job.attempt < totalAttempts

          if (willRetry) {
            logger.warn(
              `[${queue}] job "${job.name}" (${job.id}) failed on attempt ${job.attempt}, retrying`,
              error,
            )
            queueOf(queue).push({
              ...job,
              runAt: Date.now() + backoffDelay(job.backoff, job.attempt),
            })
          }
          else {
            const reason = permanent
              ? 'failed permanently and will not be retried'
              : `failed after ${job.attempt} attempt(s)`
            logger.error(`[${queue}] job "${job.name}" (${job.id}) ${reason}`, error)

            releaseDedupOnFinalize(queue, job.dedup?.id, job.id)
            remember({
              id: job.id,
              name: job.name,
              queue,
              state: 'failed',
              envelope: job.envelope,
              attemptsMade: job.attempt,
              attempts: job.attempts,
              backoff: job.backoff,
              createdAt: job.createdAt,
              finishedAt: Date.now(),
              failedReason: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
              dedupId: job.dedup?.id,
            })
          }
        }
        finally {
          active.delete(job.id)
          inFlight.delete(job.id)
        }
      }

      const loop = () => {
        if (stopped) return

        if (!paused) {
          const q = queueOf(queue)
          while (active.size < opts.concurrency) {
            const idx = q.findIndex(j => j.runAt <= Date.now())
            if (idx === -1) break
            const [job] = q.splice(idx, 1)
            job!.attempt++
            void run(job!)
          }
        }

        timer = setTimeout(loop, POLL_MS)
      }

      loop()

      const consumer: Consumer = {
        // Sets the flag and returns. Never awaits active jobs.
        pause: async () => { paused = true },

        drain: async () => {
          while (active.size > 0) await new Promise(r => setTimeout(r, POLL_MS))
        },

        close: async (force) => {
          paused = true
          if (!force) {
            while (active.size > 0) await new Promise(r => setTimeout(r, POLL_MS))
          }
          stopped = true
          if (timer) clearTimeout(timer)
        },

        activeCount: () => active.size,
        active: () => [...active.values()],
      }

      consumers.push(consumer)
      return consumer
    },

    depth: async (queue) => queueOf(queue).filter(j => j.runAt <= Date.now()).length,

    heartbeat: async (record, ttlMs) => {
      records.set(record.id, { record, expiresAt: record.lastHeartbeat + ttlMs })
    },

    deregister: async (id) => { records.delete(id) },

    workers: async () => {
      const now = Date.now()
      for (const [id, entry] of records) if (entry.expiresAt <= now) records.delete(id)
      return [...records.values()].map(e => e.record)
    },
  }

  return driverSelf
}
