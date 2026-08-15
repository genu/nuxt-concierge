import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * A payload that does not match its job's schema.
 *
 * `retryable = false` is the entire driver integration. `isPermanentFailure`
 * in drivers/bullmq.ts and the equivalent branch in drivers/memory.ts already
 * key off exactly this field, so a validation failure becomes a BullMQ
 * `UnrecoverableError` and skips the remaining attempt budget without either
 * driver knowing this class exists.
 *
 * Retrying is pointless by construction: a payload this build cannot accept
 * fails identically on every attempt, so retrying only burns the budget and
 * delays the dead-letter.
 */
export class JobPayloadInvalidError extends Error {
  readonly retryable = false
  readonly jobName: string
  readonly issues: readonly StandardSchemaV1.Issue[]

  constructor(message: string, jobName: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(`[nuxt-concierge] ${message}`)
    this.name = 'JobPayloadInvalidError'
    this.jobName = jobName
    this.issues = issues
  }
}

/**
 * Shared by the two places an `attempts` enters the module — a per-job
 * `attempts` in `handlers/defineJob.ts` and `concierge.defaults.attempts` in
 * `src/options.ts` — because they meet at `entry.attempts ?? defaults.attempts`
 * in `utils/useQueue.ts` and guarding only one of them leaves the other free
 * to lie.
 *
 * `attempts` is the TOTAL run count including the first, so `0` reads as
 * "never run" and delivered exactly one run: `0` is not nullish, so it
 * survived the `??` above, and then bullmq's `attemptsMade + 1 < 0` and
 * memory's `job.attempt < 0` are both never true. Both drivers agreed on the
 * wrong thing, which is why no conformance test caught it. A fraction is
 * rejected for the same reason `validateHistoryLimit` rejects one:
 * `attemptsMade + 1 < 2.5` yields an off-by-one budget rather than the count
 * the user wrote.
 *
 * Rejected, never coerced. Someone who wrote `attempts: 0` wants a job that
 * never runs, which this module does not offer; clamping to 1 would answer a
 * question they did not ask and hide the one they did.
 *
 * Lives on the runtime side because `src/options.ts` already depends on
 * `runtime/server` and not the reverse — importing build-time code into a
 * nitro-bundled handler would drag `defu` and `moduleDefaults` in with it.
 */
export const validateAttempts = (attempts: number, label: string, jobName?: string): void => {
  if (Number.isInteger(attempts) && attempts >= 1) return

  const where = jobName ? ` (job "${jobName}")` : ''
  throw new Error(
    `[nuxt-concierge] ${label} must be a positive integer, received ${attempts}${where}. `
    + 'It counts TOTAL runs including the first, so 1 is the smallest valid value '
    + 'and there is no value meaning "never run".',
  )
}

/**
 * `['user', 'email'] -> 'user.email'`. Standard Schema allows a path segment
 * to be either a raw key or an object wrapping one, so both are handled.
 */
export const formatIssuePath = (issue: StandardSchemaV1.Issue): string => {
  if (!issue.path?.length) return '(root)'

  return issue.path
    .map((segment) => {
      const key = typeof segment === 'object' && segment !== null && 'key' in segment
        ? segment.key
        : segment
      return String(key)
    })
    .join('.')
}

/**
 * Producer side. Validates and **discards the result**.
 *
 * Discarding is the point, not an oversight. Only the consumer's output is
 * ever used, so a transforming schema runs exactly once — enqueueing the
 * transformed output instead would make the consumer re-validate an
 * already-transformed value, and `z.string().transform(Number)` applied twice
 * fails on the second pass. A job correct at the call site would be
 * permanently dead in the worker.
 *
 * Messages are NOT redacted here: this error returns to the caller that just
 * supplied the data, in that caller's own process, and never reaches the
 * queue backend.
 *
 * Validators must not mutate their input in place. The caller hands
 * `driver.enqueue` this SAME `payload` object reference after this function
 * returns, so a validator that assigns defaults onto the input — instead of
 * onto a copy, as Zod, Valibot and ArkType all do — would half-transform what
 * gets serialized, and the consumer would then validate an already-partly-
 * transformed value: exactly the failure the discard-the-result, transform-
 * once invariant above exists to prevent.
 */
export const validateOnEnqueue = async (
  schema: StandardSchemaV1,
  jobName: string,
  payload: unknown,
): Promise<void> => {
  const result = await schema['~standard'].validate(payload)
  if (!result.issues) return

  const detail = result.issues
    .map(issue => `${formatIssuePath(issue)}: ${issue.message}`)
    .join('; ')

  throw new JobPayloadInvalidError(
    `payload for job "${jobName}" failed validation — ${detail}`,
    jobName,
    result.issues,
  )
}

/**
 * Consumer side. Validates and **returns the output**, which is what the
 * handler receives. This side is authoritative: its schema is the one from
 * the build that is actually going to run the job, which is what makes
 * validating twice worthwhile across a rolling deploy.
 *
 * The message carries issue PATHS AND A COUNT ONLY, never issue messages.
 * This text becomes BullMQ's `failedReason`, which is persisted in Redis and
 * written to the log stream, and a Standard Schema issue message can embed
 * payload data from two directions: a user-authored message (a `superRefine`
 * or `error` callback that interpolates the input — see the fixture in
 * test/unit/validate.test.ts), and another validator's defaults (ArkType emits
 * "must be a string (was 5)"). This module accepts ANY Standard Schema
 * validator, so the message cannot be trusted regardless of what one library's
 * defaults happen to do this major version.
 *
 * Deliberately NOT justified by Zod's enum/literal messages: those echoed the
 * received value in v3 but not in v4, and building the rationale on a library
 * default that quietly changed is what made the first version of this file's
 * redaction test unfalsifiable. Job payloads routinely carry user data. Same
 * reasoning as `describeEnvelopeShape` in envelope.ts, which reports an
 * unrecognised value's shape and never its content.
 *
 * The full issues remain on the error object for in-process inspection.
 */
export const validateOnConsume = async <Out>(
  schema: StandardSchemaV1<unknown, Out>,
  jobName: string,
  payload: unknown,
): Promise<Out> => {
  let result: StandardSchemaV1.Result<Out>

  try {
    result = await schema['~standard'].validate(payload)
  }
  catch (err) {
    // A validator that REJECTS rather than returning `{ issues }` has no
    // issues array to report, but the failure is exactly as permanent: a
    // schema that throws on this payload throws identically on every retry,
    // so this must still short-circuit the attempt budget rather than burn
    // it. Report the thrown value's type/shape only, never its message — the
    // same reasoning as the branch below and as `describeEnvelopeShape` in
    // envelope.ts: this text becomes BullMQ's `failedReason`, persisted in
    // Redis and logged, and a thrown error's message is exactly as
    // untrustworthy as an issue's message would be.
    const shape = err instanceof Error
      ? `Error (${err.name})`
      : `non-Error (${typeof err})`

    throw new JobPayloadInvalidError(
      `payload for job "${jobName}" failed validation in the worker: `
      + `the schema's validate() threw instead of returning issues (threw a ${shape}). `
      + `The thrown value's message is omitted because this text is persisted as the job's failedReason.`,
      jobName,
      [],
    )
  }

  if (result.issues) {
    const paths = [...new Set(result.issues.map(formatIssuePath))].sort().join(', ')

    throw new JobPayloadInvalidError(
      `payload for job "${jobName}" failed validation in the worker: `
      + `${result.issues.length} issue(s) at ${paths}. `
      + `Issue messages are omitted because this text is persisted as the job's failedReason.`,
      jobName,
      result.issues,
    )
  }

  return result.value
}
