import { describe, it, expect } from 'vitest'
import { resolveDriverName } from '../../../src/runtime/server/drivers'

describe('resolveDriverName', () => {
  it('passes explicit names through untouched', () => {
    expect(resolveDriverName({ configured: 'memory', hasConnection: true, isProduction: true })).toBe('memory')
    expect(resolveDriverName({ configured: 'sync', hasConnection: false, isProduction: false })).toBe('sync')
  })

  it('auto resolves to bullmq when a connection is present', () => {
    expect(resolveDriverName({ configured: 'auto', hasConnection: true, isProduction: true })).toBe('bullmq')
  })

  it('auto resolves to memory outside production when no connection is present', () => {
    expect(resolveDriverName({ configured: 'auto', hasConnection: false, isProduction: false })).toBe('memory')
  })

  it('auto throws a targeted error in production with no connection', () => {
    // Without this the memory driver would be selected, then guardrail 1 would
    // throw a confusing crossProcess capability error when the real problem is
    // a missing REDIS_URL.
    expect(() => resolveDriverName({ configured: 'auto', hasConnection: false, isProduction: true }))
      .toThrow(/REDIS_URL/)
  })
})
