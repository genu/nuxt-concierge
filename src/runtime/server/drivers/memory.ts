import { consola } from 'consola'
import { decodePayload, encodePayload } from '../envelope'
import type { ActiveJob, BackoffOptions, JobHandler, WorkerRecord } from '../types'
import type { ConciergeDriver, Consumer } from './types'

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
 * probe in the spec 3 plan, Task 11 Step 1.
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

/**
 * In-process queue with a real claim loop so delays, retries and concurrency
 * behave like the persistent driver. Loses everything on process death — that
 * is acceptable for a dev/test driver and is stated loudly in the docs.
 */
export const createMemoryDriver = (): ConciergeDriver => {
  const pending = new Map<string, QueuedJob[]>()
  const handlers = new Map<string, JobHandler>()
  const records = new Map<string, { record: WorkerRecord, expiresAt: number }>()
  const consumers: Consumer[] = []
  let counter = 0

  const key = (queue: string, name: string) => `${queue}::${name}`
  const queueOf = (queue: string) => {
    if (!pending.has(queue)) pending.set(queue, [])
    return pending.get(queue)!
  }

  return {
    name: 'memory',
    capabilities: { persistent: false, crossProcess: false, history: 'bounded' },

    init: async () => {},
    isHealthy: () => true,

    close: async (force) => {
      await Promise.all(consumers.splice(0).map(c => c.close(force)))
      pending.clear()
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
          }
        }
        finally {
          active.delete(job.id)
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
