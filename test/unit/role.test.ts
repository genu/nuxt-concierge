import { describe, it, expect } from 'vitest'
import { resolveRole, resolveVersion } from '../../src/runtime/server/role'

describe('resolveRole', () => {
  it('defaults to both in dev', () => {
    expect(resolveRole({ isDev: true })).toBe('both')
  })

  it('defaults to web in production', () => {
    expect(resolveRole({ isDev: false })).toBe('web')
  })

  it('prefers env over config', () => {
    expect(resolveRole({ env: 'worker', config: 'web', isDev: false })).toBe('worker')
  })

  it('falls back to config when env is absent', () => {
    expect(resolveRole({ config: 'both', isDev: false })).toBe('both')
  })

  it('ignores an empty env string', () => {
    expect(resolveRole({ env: '', config: 'worker', isDev: false })).toBe('worker')
  })

  it('throws on an invalid env value rather than silently doing nothing', () => {
    expect(() => resolveRole({ env: 'workers', isDev: false }))
      .toThrow(/CONCIERGE_ROLE.*"workers".*web \| worker \| both/)
  })

  it('throws on an invalid config value', () => {
    expect(() => resolveRole({ config: 'Worker', isDev: false }))
      .toThrow(/concierge\.role.*"Worker"/)
  })
})

describe('resolveVersion', () => {
  it('prefers CONCIERGE_VERSION so CI can inject a git sha', () => {
    expect(resolveVersion({ env: 'abc1234', packageVersion: '2.0.0' })).toBe('abc1234')
  })

  it('falls back to the host package version', () => {
    expect(resolveVersion({ packageVersion: '2.0.0' })).toBe('2.0.0')
  })

  it('falls back to "unknown" rather than empty string', () => {
    expect(resolveVersion({})).toBe('unknown')
    expect(resolveVersion({ env: '  ', packageVersion: '' })).toBe('unknown')
  })
})
