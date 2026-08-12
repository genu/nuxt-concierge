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
})
