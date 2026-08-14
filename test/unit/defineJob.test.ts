import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'
import { JobPayloadInvalidError } from '../../src/runtime/server/validate'

describe('defineJob', () => {
  it('keeps an explicit name and queue', () => {
    const job = defineJob({ name: 'send-email', queue: 'mail', handler: async () => {} })
    expect(job.name).toBe('send-email')
    expect(job.queue).toBe('mail')
  })

  it('defaults the queue to "default"', () => {
    expect(defineJob({ name: 'j', handler: async () => {} }).queue).toBe('default')
  })

  it('leaves the name empty when omitted so the build can infer it from the filename', () => {
    expect(defineJob({ handler: async () => {} }).name).toBe('')
  })

  it('throws when no handler is supplied', () => {
    // @ts-expect-error deliberately invalid
    expect(() => defineJob({ name: 'j' })).toThrow(/handler/)
  })

  it('exposes the user handler and a driver-facing run wrapper', async () => {
    const seen: unknown[] = []
    const job = defineJob<{ n: number }>({
      handler: (ctx) => { seen.push(ctx.payload) },
    })

    await job.run({ id: '1', name: 'j', queue: 'default', attempt: 1, payload: { n: 7 } })

    expect(seen).toEqual([{ n: 7 }])
    expect(job.handler).toBeTypeOf('function')
    expect(job.run).toBeTypeOf('function')
  })

  it('carries attempts and backoff through untouched', () => {
    const job = defineJob({
      attempts: 5,
      backoff: { type: 'fixed', delay: 250 },
      handler: () => {},
    })

    expect(job.attempts).toBe(5)
    expect(job.backoff).toEqual({ type: 'fixed', delay: 250 })
  })

  it('leaves attempts and backoff undefined so config defaults can apply', () => {
    const job = defineJob({ handler: () => {} })

    // Not `0`/`null`: `undefined` is what lets `entry.attempts ?? defaults.attempts`
    // fall through in useQueue. A defaulted-here value would make the module
    // default unreachable.
    expect(job.attempts).toBeUndefined()
    expect(job.backoff).toBeUndefined()
  })
})

describe('defineJob consumer-side validation', () => {
  const ctx = (payload: unknown) => ({
    id: '1', name: 'j', queue: 'default', attempt: 1, payload,
  })

  it('passes the schema OUTPUT to the handler, not the raw input', async () => {
    const seen: unknown[] = []
    const job = defineJob({
      input: z.object({ id: z.string().transform(Number), label: z.string().default('none') }),
      handler: (c) => { seen.push(c.payload) },
    })

    await job.run(ctx({ id: '42' }))

    expect(seen).toEqual([{ id: 42, label: 'none' }])
  })

  it('throws a permanent JobPayloadInvalidError and never calls the handler', async () => {
    let called = false
    const job = defineJob({
      input: z.object({ n: z.number() }),
      handler: () => { called = true },
    })

    await expect(job.run(ctx({ n: 'not a number' }))).rejects.toThrow(JobPayloadInvalidError)

    // Both halves: a throw that still ran the handler would leave the side
    // effects applied and then fail the job, which is the worst outcome.
    expect(called).toBe(false)
  })

  it('leaves the payload untouched when the job declares no schema', async () => {
    const seen: unknown[] = []
    const job = defineJob<{ raw: string }>({ handler: (c) => { seen.push(c.payload) } })

    await job.run(ctx({ raw: 'as-is' }))

    expect(seen).toEqual([{ raw: 'as-is' }])
  })

  it('preserves the rest of the context across validation', async () => {
    const seen: Array<{ id: string, attempt: number, queue: string, name: string }> = []
    const job = defineJob({
      input: z.object({ n: z.number() }),
      handler: (c) => { seen.push({ id: c.id, attempt: c.attempt, queue: c.queue, name: c.name }) },
    })

    await job.run({ id: 'abc', name: 'typed', queue: 'mail', attempt: 3, payload: { n: 1 } })

    expect(seen).toEqual([{ id: 'abc', attempt: 3, queue: 'mail', name: 'typed' }])
  })

  it('awaits an async handler so a rejection propagates to the driver', async () => {
    const job = defineJob<undefined>({
      handler: async () => { throw new Error('handler blew up') },
    })

    // If `run` did not await, this would resolve and the driver would mark a
    // failed job complete.
    await expect(job.run(ctx(undefined))).rejects.toThrow('handler blew up')
  })
})

describe('defineJob cron', () => {
  it('resolves the string shorthand to a full spec', () => {
    const job = defineJob({ cron: '0 9 * * *', handler: async () => {} })
    expect(job.cron).toEqual({ expression: '0 9 * * *', tz: 'UTC' })
  })

  it('keeps an explicit timezone and static payload', () => {
    const job = defineJob({
      cron: { expression: '0 9 * * MON', tz: 'America/Toronto', payload: { scope: 'weekly' } },
      handler: async () => {},
    })
    expect(job.cron).toEqual({
      expression: '0 9 * * MON', tz: 'America/Toronto', payload: { scope: 'weekly' },
    })
  })

  it('throws at definition time on a bad expression', () => {
    expect(() => defineJob({ cron: 'nope', handler: async () => {} }))
      .toThrow(/not a valid cron expression/)
  })

  it('leaves cron undefined for an ordinary job', () => {
    expect(defineJob({ handler: async () => {} }).cron).toBeUndefined()
  })
})

describe('defineJob unique', () => {
  it('resolves `true` to lock mode', () => {
    expect(defineJob({ unique: true, handler: async () => {} }).unique).toEqual({})
  })

  it('keeps a ttl for throttle mode', () => {
    expect(defineJob({ unique: { ttl: 60_000 }, handler: async () => {} }).unique)
      .toEqual({ ttl: 60_000 })
  })

  it('rejects debounce without a ttl', () => {
    // `extend`/`replace` with no expiry is BullMQ's replace-with-no-expiry
    // branch — a lock that keeps moving, not a debounce. Rejecting it at
    // definition time is what makes the combination unrepresentable rather
    // than quietly reinterpreted.
    expect(() => defineJob({ unique: { debounce: true }, handler: async () => {} }))
      .toThrow(/debounce requires a ttl/)
  })

  it('leaves unique undefined for an ordinary job', () => {
    expect(defineJob({ handler: async () => {} }).unique).toBeUndefined()
  })
})
