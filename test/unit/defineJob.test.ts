import { describe, it, expect } from 'vitest'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'

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
