import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { BackoffOptions, JobContext, JobDefinition, JobHandler, UniqueOptions } from '../types'
import type { CronInput } from '../cron'
import { resolveCron } from '../cron'
import { validateOnConsume } from '../validate'

/**
 * `In` defaults to `Out` so the no-schema case (where they are the same type)
 * needs no second argument. The two are only distinct when an `input` schema
 * transforms — and `uniqueId` needs `In`, not `Out`.
 */
export interface DefineJobOptions<Out, In = Out> {
  /** Defaults to the filename, resolved at build time. */
  name?: string
  /** Must exist in concierge.worker.queues or the build fails. */
  queue?: string
  /** TOTAL attempts including the first. Falls back to `concierge.defaults`. */
  attempts?: number
  backoff?: BackoffOptions
  handler: JobHandler<Out>
  /** A schedule. String shorthand, or the object form for a timezone or payload. */
  cron?: CronInput
  /** `true` is lock mode. `{ ttl }` throttles. `{ ttl, debounce: true }` debounces. */
  unique?: boolean | UniqueOptions
  /**
   * Producer-side key derivation. MUST be pure — an impure key does not fail
   * loudly, it just stops deduplicating.
   *
   * Receives `In`, the ENQUEUE-side payload, NOT `Out`. This runs alongside
   * `validateOnEnqueue`, whose result is deliberately discarded so a
   * transforming schema applies exactly once — in the worker. The transformed
   * value therefore does not exist at the call site, and typing this against
   * `Out` would promise a shape the function is never handed.
   */
  uniqueId?: (payload: In) => string
}

/**
 * Overload 1 — an `input` schema supplies both payload types. Declared FIRST
 * so it wins whenever `input` is present.
 */
export function defineJob<S extends StandardSchemaV1>(
  opts: DefineJobOptions<StandardSchemaV1.InferOutput<S>, StandardSchemaV1.InferInput<S>> & { input: S },
): JobDefinition<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>>

/**
 * Overload 2 — an explicit type argument supplies the payload type.
 *
 * `input?: never` is what makes `defineJob<P>({ input: schema })` a compile
 * error instead of a silent case where the type argument and the schema
 * disagree about the payload.
 */
export function defineJob<Payload = unknown>(
  opts: DefineJobOptions<Payload> & { input?: never },
): JobDefinition<Payload, Payload>

export function defineJob(
  opts: {
    name?: string
    queue?: string
    attempts?: number
    backoff?: BackoffOptions
    input?: StandardSchemaV1
    // `never` accepts any JobHandler<X> by contravariance, which is what lets
    // one implementation signature satisfy both overloads above.
    handler: JobHandler<never>
    cron?: CronInput
    unique?: boolean | UniqueOptions
    uniqueId?: (payload: never) => string
  },
): JobDefinition<unknown, unknown> {
  if (typeof opts?.handler !== 'function') {
    throw new Error('[nuxt-concierge] defineJob requires a handler function')
  }

  // A POSITIVE ttl, not merely a defined one. `{ ttl: 0, debounce: true }` used
  // to pass this check and then resolve to `{ extend: true, replace: true }`
  // with no expiry — which is the moving lock this error exists to reject,
  // arriving with no error at all. Same for a negative value.
  if (opts.unique && typeof opts.unique === 'object' && opts.unique.debounce
    && !(typeof opts.unique.ttl === 'number' && opts.unique.ttl > 0)) {
    throw new Error(
      '[nuxt-concierge] unique.debounce requires a ttl. Without an expiry, `extend` and '
      + '`replace` produce a lock that keeps moving rather than a debounce window.',
    )
  }

  const unique = opts.unique === true
    ? {}
    : opts.unique === false || opts.unique === undefined
      ? undefined
      : opts.unique

  const handler = opts.handler as JobHandler<unknown>

  return {
    name: opts.name ?? '',
    queue: opts.queue ?? 'default',
    handler,
    input: opts.input,
    attempts: opts.attempts,
    backoff: opts.backoff,
    /**
     * Validation lives here, inside the function the driver calls, so a
     * failure throws inside the driver's own try/catch and its existing
     * `retryable === false` branch classifies it as permanent. Validating
     * before handing the job to the driver would put the throw outside that
     * handling and lose the classification.
     */
    run: async (ctx: JobContext<unknown>) => {
      const payload = opts.input
        ? await validateOnConsume(opts.input, ctx.name, ctx.payload)
        : ctx.payload

      await handler({ ...ctx, payload })
    },
    // Resolved HERE rather than at boot so a typo'd expression throws where
    // the job is written, with that file already on the stack.
    cron: opts.cron === undefined ? undefined : resolveCron(opts.cron),
    unique,
    // `uniqueId` is cast because `DefineJobOptions<Out>` types it against the
    // concrete payload while `JobDefinition` holds it contravariantly for the
    // collection type. This is the same accommodation `handler`/`run` already
    // makes, and for the same reason.
    uniqueId: opts.uniqueId as JobDefinition['uniqueId'],
  }
}
