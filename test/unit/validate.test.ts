import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
  JobPayloadInvalidError,
  formatIssuePath,
  validateOnConsume,
  validateOnEnqueue,
} from '../../src/runtime/server/validate'
import { isPermanentFailure } from '../../src/runtime/server/drivers/bullmq'

/**
 * A hand-rolled Standard Schema whose `validate` REJECTS rather than
 * returning `{ issues }`. Zod, Valibot and ArkType never do this — they
 * always resolve to a result object — but nothing in the Standard Schema
 * spec forbids it, and this module accepts any conforming validator.
 */
const throwingSchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'test-fixture',
    validate: async () => {
      throw new Error('exploded while looking at secret-payload-value-42')
    },
  },
}

const schema = z.object({
  to: z.string(),
  mode: z.enum(['fast', 'slow']),
})

// A CUSTOM message that interpolates the received value, deliberately.
//
// A plain `z.enum` cannot serve here: Zod v4's default enum/literal messages
// report only the allowed options ("Invalid option: expected one of ...") and
// never echo the received value, unlike Zod v3. So an enum fixture would make
// the exclusion assertion below pass even against a validateOnConsume that
// leaks messages verbatim — an assertion that cannot fail, in the test written
// to prevent exactly that.
//
// The threat redaction guards against is not Zod's defaults specifically. It is
// any message that embeds payload data: user-authored messages like this one,
// and other Standard Schema validators whose defaults do echo values (ArkType
// emits "must be a string (was 5)"). Authoring the message ourselves also makes
// the fixture version-robust — it cannot silently stop echoing the value the way
// a library default just did.
const leakySchema = z.object({
  to: z.string(),
  mode: z.string().superRefine((val, ctx) => {
    ctx.addIssue({ code: 'custom', message: `unsupported mode: ${val}` })
  }),
})

describe('validateOnEnqueue', () => {
  it('resolves and returns nothing for a valid payload', async () => {
    await expect(validateOnEnqueue(schema, 'j', { to: 'a@b.c', mode: 'fast' }))
      .resolves.toBeUndefined()
  })

  it('throws JobPayloadInvalidError naming the job', async () => {
    await expect(validateOnEnqueue(schema, 'send-email', { to: 1, mode: 'fast' }))
      .rejects.toThrow(JobPayloadInvalidError)
    await expect(validateOnEnqueue(schema, 'send-email', { to: 1, mode: 'fast' }))
      .rejects.toThrow(/send-email/)
  })

  it('includes full issue messages, because this error stays in the caller process', async () => {
    const error = await validateOnEnqueue(leakySchema, 'j', { to: 'a', mode: 'sideways' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error).toBeInstanceOf(JobPayloadInvalidError)
    expect(error.message).toContain('mode')
    // This schema's custom message embeds the received value. On the
    // PRODUCER side that is fine and useful: this error returns to whoever
    // supplied the data.
    expect(error.message).toContain('sideways')
  })

  it('exposes structured issues so a route can map them to a 400', async () => {
    const error = await validateOnEnqueue(schema, 'j', { to: 1, mode: 'fast' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error.issues.length).toBeGreaterThan(0)
    expect(error.jobName).toBe('j')
    expect(formatIssuePath(error.issues[0]!)).toBe('to')
  })

  it('awaits an async schema', async () => {
    const asyncSchema = z.object({ n: z.number() }).refine(
      async v => v.n > 0,
      { message: 'must be positive' },
    )

    await expect(validateOnEnqueue(asyncSchema, 'j', { n: -1 })).rejects.toThrow(JobPayloadInvalidError)
    await expect(validateOnEnqueue(asyncSchema, 'j', { n: 1 })).resolves.toBeUndefined()
  })
})

describe('validateOnConsume', () => {
  it('returns the validated OUTPUT, not the input', async () => {
    const transforming = z.object({ id: z.string().transform(Number) })

    await expect(validateOnConsume(transforming, 'j', { id: '42' }))
      .resolves.toEqual({ id: 42 })
  })

  it('redacts issue messages but reports the path', async () => {
    const error = await validateOnConsume(leakySchema, 'j', { to: 'a', mode: 'sideways' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    // Both halves are required. Asserting only the exclusion would pass on an
    // empty message; asserting only the inclusion would pass on a message
    // that leaked the value alongside the path.
    expect(error.message).not.toContain('sideways')
    expect(error.message).toContain('mode')
  })

  it('reports the issue count', async () => {
    const error = await validateOnConsume(schema, 'j', { to: 1, mode: 'nope' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error.message).toContain('2 issue')
  })

  it('keeps structured issues on the error even though the message omits them', async () => {
    const error = await validateOnConsume(leakySchema, 'j', { to: 'a', mode: 'sideways' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    // Redaction protects the SERIALISED message (BullMQ's failedReason).
    // In-process consumers can still inspect the detail.
    expect(error.issues.some(i => i.message.includes('sideways'))).toBe(true)
  })

  it('classifies as a permanent failure through the drivers existing check', async () => {
    const error = await validateOnConsume(schema, 'j', { to: 1, mode: 'fast' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error.retryable).toBe(false)
    // The whole driver integration: no bullmq/memory change is needed because
    // both already branch on `retryable === false`.
    expect(isPermanentFailure(error)).toBe(true)
  })

  it('converts a validator that THROWS, instead of returning issues, into a non-retryable error', async () => {
    // A validation failure that returns `{ issues }` already dead-letters
    // immediately via the branch above. A validator that REJECTS instead has
    // no issues array — without this, the thrown error would carry no
    // `retryable: false` and a failure guaranteed to repeat identically would
    // burn the entire attempt budget instead of dead-lettering on the first
    // attempt.
    const error = await validateOnConsume(throwingSchema, 'j', { anything: true })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error).toBeInstanceOf(JobPayloadInvalidError)
    expect(error.retryable).toBe(false)
  })

  it('does not leak the thrown error message (or any payload value) when a validator throws', async () => {
    const error = await validateOnConsume(throwingSchema, 'j', { secret: 'secret-payload-value-42' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    // A thrown error has no issues array to redact selectively, so the whole
    // thrown message is omitted — same reasoning as the issues branch above:
    // this text is persisted as BullMQ's `failedReason`.
    expect(error.message).not.toContain('secret-payload-value-42')
    expect(error.message).not.toContain('exploded')
  })
})

describe('formatIssuePath', () => {
  it('joins nested path segments with dots', () => {
    expect(formatIssuePath({ message: 'x', path: ['user', 'email'] })).toBe('user.email')
  })

  it('unwraps object path segments', () => {
    expect(formatIssuePath({ message: 'x', path: [{ key: 'user' }, { key: 0 }] })).toBe('user.0')
  })

  it('reports a root-level issue distinctly', () => {
    expect(formatIssuePath({ message: 'x' })).toBe('(root)')
    expect(formatIssuePath({ message: 'x', path: [] })).toBe('(root)')
  })
})
