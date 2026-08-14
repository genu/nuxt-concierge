import { consola } from 'consola'
import { decodePayload, encodePayload } from '../envelope'
import type { MemoryOptions } from '../../../options'
import type { ActiveJob, BackoffOptions, JobHandler, WorkerRecord } from '../types'
import type { ConciergeDriver, Consumer, JobDetail, JobState, JobSummary } from './types'

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

  return {
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

    init: async () => {},
    isHealthy: () => true,

    close: async (force) => {
      await Promise.all(consumers.splice(0).map(c => c.close(force)))
      pending.clear()
      history.clear()
      inFlight.clear()
    },

    registerHandler: (queue, name, handler) => {
      handlers.set(key(queue, name), handler)
    },

    enqueue: async (queue, job) => {
      const id = `mem-${++counter}`
      queueOf(queue).push({
        id,
        name: job.name,
        queue,
        envelope: encodePayload(job.payload),
        attempt: 0,
        runAt: Date.now() + (job.delay ?? 0),
        attempts: job.attempts,
        backoff: job.backoff,
        createdAt: Date.now(),
      })
      return { id }
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
          })

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
}
