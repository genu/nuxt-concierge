import { decodePayload, encodePayload } from '../envelope'
import type { ActiveJob, JobHandler, WorkerRecord } from '../types'
import type { ConciergeDriver, Consumer } from './types'

const MAX_ATTEMPTS = 3
const POLL_MS = 10

interface QueuedJob {
  id: string
  name: string
  queue: string
  envelope: { v: number, payload: string }
  attempt: number
  runAt: number
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
  const consumers: Array<{ stop: () => void }> = []
  let counter = 0

  const key = (queue: string, name: string) => `${queue}::${name}`
  const queueOf = (queue: string) => {
    if (!pending.has(queue)) pending.set(queue, [])
    return pending.get(queue)!
  }

  return {
    name: 'memory',
    capabilities: { persistent: false, crossProcess: false },

    init: async () => {},

    close: async () => {
      for (const c of consumers) c.stop()
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
          const fatal = (error as { retryable?: boolean }).retryable === false
          if (!fatal && job.attempt < MAX_ATTEMPTS) {
            queueOf(queue).push({ ...job, runAt: Date.now() })
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
      const self = { stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
      consumers.push(self)

      return {
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
          self.stop()
        },

        activeCount: () => active.size,
        active: () => [...active.values()],
      }
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
