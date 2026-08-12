import { describe, it, expect } from 'vitest'
import {
  buildConnection,
  isPermanentFailure,
  resolveBullmqOptions,
  workerRecordKey,
  WORKER_KEY_PREFIX,
} from '../../../src/runtime/server/drivers/bullmq'
import { UnsupportedEnvelopeError } from '../../../src/runtime/server/envelope'

describe('bullmq connection mapping', () => {
  it('prefers a url when given', () => {
    expect(buildConnection({ url: 'redis://user:pw@example:6380' }))
      .toEqual({ url: 'redis://user:pw@example:6380' })
  })

  it('falls back to discrete fields', () => {
    expect(buildConnection({ host: 'h', port: 6379, password: 'p' }))
      .toEqual({ host: 'h', port: 6379, password: 'p' })
  })

  it('throws when neither is usable rather than silently connecting to localhost', () => {
    expect(() => buildConnection({})).toThrow(/connection/i)
  })
})

describe('worker record keys', () => {
  it('namespaces keys so they cannot collide with queue keys', () => {
    expect(workerRecordKey('abc')).toBe(`${WORKER_KEY_PREFIX}abc`)
    expect(WORKER_KEY_PREFIX).toMatch(/^concierge:workers:/)
  })
})

describe('resolveBullmqOptions', () => {
  it('applies both defaults when nothing is given', () => {
    expect(resolveBullmqOptions()).toEqual({ maxStalledCount: 3, stalledInterval: 30_000 })
  })

  it('respects a full explicit override', () => {
    expect(resolveBullmqOptions({ maxStalledCount: 7, stalledInterval: 1_000 }))
      .toEqual({ maxStalledCount: 7, stalledInterval: 1_000 })
  })

  it('fills a missing field from defaults instead of dropping it', () => {
    expect(resolveBullmqOptions({ maxStalledCount: 5 }))
      .toEqual({ maxStalledCount: 5, stalledInterval: 30_000 })
    expect(resolveBullmqOptions({ stalledInterval: 2_000 }))
      .toEqual({ maxStalledCount: 3, stalledInterval: 2_000 })
  })
})

describe('isPermanentFailure', () => {
  it('is true for UnsupportedEnvelopeError, which marks itself non-retryable', () => {
    expect(isPermanentFailure(new UnsupportedEnvelopeError('bad payload'))).toBe(true)
  })

  it('is false for a plain Error', () => {
    expect(isPermanentFailure(new Error('boom'))).toBe(false)
  })

  it('is false for a non-Error throwable like a string', () => {
    expect(isPermanentFailure('boom')).toBe(false)
  })

  it('is true for any object literal carrying retryable: false', () => {
    expect(isPermanentFailure({ retryable: false })).toBe(true)
  })
})
