import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Role = 'web' | 'worker' | 'both'
export type SupervisorState = 'starting' | 'running' | 'draining' | 'stopped'

/**
 * Mirrors BullMQ's `{ type, delay }` shape deliberately, so the bullmq driver
 * passes it straight through. Any translation layer here is a place for an
 * off-by-one to hide. `jitter` is not exposed: the memory driver has no
 * conformance story for it.
 */
export interface BackoffOptions {
  type: 'fixed' | 'exponential'
  delay: number
}

export interface ActiveJob {
  jobId: string
  queue: string
  name: string
  startedAt: number
}

export interface WorkerRecord {
  id: string
  hostname: string
  pid: number
  /**
   * The supervisor's actual configured role, including `web`. A `web`
   * process's record used to be reported as `both`; Task 10's health
   * endpoint reads this field directly, so misreporting it would be a lie
   * a caller could act on.
   */
  role: Role
  queues: string[]
  concurrency: Record<string, number>
  version: string
  startedAt: number
  lastHeartbeat: number
  state: 'running' | 'draining'
  active: ActiveJob[]
}

/** What a handler receives. `Payload` is the schema OUTPUT when a job declares `input`. */
export interface JobContext<Payload = unknown> {
  id: string
  name: string
  queue: string
  attempt: number
  payload: Payload
}

export type JobHandler<Payload = unknown> = (ctx: JobContext<Payload>) => Promise<void> | void

export interface JobDefinition<In = unknown, Out = In> {
  name: string
  queue: string
  /**
   * The handler as the user wrote it, typed with the payload OUTPUT. Drivers
   * never call this directly — they call `run`.
   */
  handler: JobHandler<Out>
  /**
   * Driver-facing. Validates the decoded payload (when `input` is present)
   * and then delegates to `handler`.
   *
   * Separate from `handler` because a driver has no payload type information
   * and must be handed a `JobHandler<unknown>` — and `JobHandler<Out>` is not
   * assignable to `JobHandler<unknown>`, since parameter contravariance
   * requires `JobContext<unknown>` to be assignable to `JobContext<Out>`,
   * which is false for every concrete `Out`.
   *
   * Validation living HERE is load-bearing: it means a validation failure
   * throws inside the driver's own try/catch, so the drivers' existing
   * `retryable === false` checks classify it as permanent with no driver
   * changes at all.
   */
  run: JobHandler<unknown>
  input?: StandardSchemaV1<In, Out>
  /** TOTAL attempts including the first. Falls back to `concierge.defaults`. */
  attempts?: number
  backoff?: BackoffOptions
  /**
   * Type-only carrier, never assigned at runtime and never read.
   *
   * Without it `In` appears only inside `input`, which is optional and nests
   * the types two levels deep (`~standard.types.input`) — fragile to infer
   * through, and absent entirely from a job that declares no schema. An
   * interface whose type parameters appear in no member is structurally
   * identical for every instantiation, so `T extends JobDefinition<infer In,
   * infer Out>` would silently infer `unknown` for both and every payload
   * would go unchecked while the generated map still looked correct.
   */
  readonly __payloadTypes?: { input: In, output: Out }
}

/**
 * Extracts the ENQUEUE-side payload type (the schema input) from a job module's
 * default export. Used by the generated `ConciergeJobMap`.
 *
 * Both parameters must be inferred. `JobDefinition<infer In, unknown>` looks
 * equivalent and is not: matching it requires `JobHandler<Out>` to be
 * assignable to `JobHandler<unknown>`, which parameter contravariance makes
 * false, so the conditional would fall through to `unknown` for every job.
 */
export type EnqueueInputOf<T>
  = T extends JobDefinition<infer In, infer _Out> ? In : unknown

/** Extracts the HANDLER-side payload type (the schema output). */
export type JobPayloadOf<T>
  = T extends JobDefinition<infer _In, infer Out> ? Out : unknown

/**
 * A job definition of any payload type, for places that hold a COLLECTION of
 * definitions rather than acting on one.
 *
 * `JobDefinition[]` cannot serve: it means `JobDefinition<unknown, unknown>[]`,
 * and a typed definition is not assignable to that, because `handler` is
 * declared with property syntax and is therefore contravariant in its payload.
 *
 * The obvious alternative — declaring `handler` with method syntax to restore
 * bivariance — is deliberately NOT taken. Under the current declaration a typed
 * job's `handler` is *rejected* by `registerHandler`'s `JobHandler<unknown>`
 * parameter, which is what forces callers through `run` and is therefore what
 * stops a future edit from silently bypassing consumer-side validation.
 * Widening only the element type keeps that protection intact.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the doc comment above: the point is to accept every instantiation, which only `any` does bivariantly.
export type AnyJobDefinition = JobDefinition<any, any>
