import { getDriver } from '../supervisor'
import { validateOnEnqueue } from '../validate'
import { resolveDedup } from '../dedup'
import type { EnqueueResult } from '../drivers/types'

export interface EnqueueJobOptions {
  delay?: number
}

/**
 * `JobMap`, not `Map`: a type parameter named `Map` shadows the global `Map`
 * for the whole interface body. Harmless while the body never needs the real
 * one, and a trap for the first edit that does.
 */
export interface TypedQueue<JobMap> {
  enqueue: <K extends keyof JobMap>(
    name: K,
    payload: JobMap[K],
    opts?: EnqueueJobOptions,
  ) => Promise<EnqueueResult>
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
      // Derived from the RAW payload, deliberately. `validateOnEnqueue`
      // discards its result so a transforming schema runs exactly once — in
      // the worker — which means the transformed value does not exist here and
      // the key must come from what the caller actually passed.
      dedup: resolveDedup({
        jobName: String(name),
        payload,
        unique: entry.unique,
        // Cast for the same reason `defineJob` casts on the way in:
        // `RegistryEntry.uniqueId` holds `(payload: never) => string`
        // contravariantly across every payload type in the registry, while
        // `resolveDedup` accepts the permissive `(payload: any) => string` —
        // sound here because this payload has already been validated
        // against this exact job's own schema.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
        uniqueId: entry.uniqueId as ((payload: any) => string) | undefined,
      }),
    })
  },
})
