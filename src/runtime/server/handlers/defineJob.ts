import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { BackoffOptions, JobContext, JobDefinition, JobHandler } from '../types'
import { validateOnConsume } from '../validate'

export interface DefineJobOptions<Out> {
  /** Defaults to the filename, resolved at build time. */
  name?: string
  /** Must exist in concierge.worker.queues or the build fails. */
  queue?: string
  /** TOTAL attempts including the first. Falls back to `concierge.defaults`. */
  attempts?: number
  backoff?: BackoffOptions
  handler: JobHandler<Out>
}

/**
 * Overload 1 — an `input` schema supplies both payload types. Declared FIRST
 * so it wins whenever `input` is present.
 */
export function defineJob<S extends StandardSchemaV1>(
  opts: DefineJobOptions<StandardSchemaV1.InferOutput<S>> & { input: S },
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
  },
): JobDefinition<unknown, unknown> {
  if (typeof opts?.handler !== 'function') {
    throw new Error('[nuxt-concierge] defineJob requires a handler function')
  }

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
  }
}
