import { getDriver } from '../supervisor'
import { validateOnEnqueue } from '../validate'

export interface EnqueueJobOptions {
  delay?: number
}

export interface TypedQueue<Map> {
  enqueue: <K extends keyof Map>(
    name: K,
    payload: Map[K],
    opts?: EnqueueJobOptions,
  ) => Promise<{ id: string }>
}

/**
 * Enqueue from anywhere in server/.
 *
 * The public, typed signature is `TypedQueue<ConciergeJobMap>`, bound by the
 * generated ambient declaration for `#concierge` (see src/templates.ts). The
 * implementation is deliberately loose, because at runtime there is no map —
 * only the registry the supervisor built from each job's own `defineJob`.
 *
 * The queue always comes from the registry (built from each job's own
 * `defineJob` declaration), never from a caller-supplied override: an
 * override would let a typo'd queue name bypass the "no such job" check
 * entirely and go straight to the driver.
 */
export const useQueue = (): TypedQueue<Record<string, unknown>> => ({
  enqueue: async (name, payload, opts = {}) => {
    const { driver, registry, defaults } = getDriver()
    const entry = registry.get(String(name))

    if (!entry) {
      throw new Error(
        `[nuxt-concierge] no job named "${String(name)}" is registered. `
        + `Create server/jobs/${String(name)}.ts.`,
      )
    }

    // Validated BEFORE enqueueing and the result discarded. Failing here
    // turns "the job dead-letters in a worker minutes from now" into "this
    // call throws", and discarding the output is what keeps a transforming
    // schema running exactly once — in the worker, whose schema is
    // authoritative across a rolling deploy.
    if (entry.input) await validateOnEnqueue(entry.input, String(name), payload)

    return driver.enqueue(entry.queue, {
      name: String(name),
      payload,
      delay: opts.delay,
      // Resolved here rather than in the driver: BullMQ takes both as job
      // options at add() time, so the producer is the only place that can
      // attach them.
      attempts: entry.attempts ?? defaults.attempts,
      backoff: entry.backoff ?? defaults.backoff,
    })
  },
})
