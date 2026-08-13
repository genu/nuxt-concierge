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
  const result = await schema['~standard'].validate(payload)

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
