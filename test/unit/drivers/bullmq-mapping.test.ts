import { describe, it, expect } from 'vitest'
import { buildConnection, workerRecordKey, WORKER_KEY_PREFIX } from '../../../src/runtime/server/drivers/bullmq'

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
