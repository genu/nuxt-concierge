import { describe, it, expect, vi } from 'vitest'

// role-gate.ts imports useRuntimeConfig from '#imports', which only resolves
// inside a Nuxt/Nitro build. This file only exercises the pure, exported
// functions (isHealthPath, resolveGateRole, shouldRefuse) — none of which
// touch runtime config — so '#imports' is stubbed purely to make the module
// importable under plain vitest.
vi.mock('#imports', () => ({ useRuntimeConfig: () => ({ concierge: {} }) }))

const { isHealthPath, resolveGateRole, shouldRefuse } = await import('../../src/runtime/server/middleware/role-gate')

describe('isHealthPath', () => {
  it('matches the bare health path', () => {
    expect(isHealthPath('/_concierge/health')).toBe(true)
  })

  it('matches the health path with a trailing slash', () => {
    expect(isHealthPath('/_concierge/health/')).toBe(true)
  })

  it('matches the health path with a query string', () => {
    expect(isHealthPath('/_concierge/health?x=1')).toBe(true)
  })

  it('does not match a different route that merely shares the string prefix', () => {
    // A naive startsWith('/_concierge/health') would wrongly allow this.
    expect(isHealthPath('/_concierge/healthz')).toBe(false)
  })

  it('does not match a deeper sub-path', () => {
    expect(isHealthPath('/_concierge/health/sub')).toBe(false)
  })

  it('does not match a case-differing variant', () => {
    expect(isHealthPath('/_CONCIERGE/Health')).toBe(false)
  })

  it('does not match an ordinary application route', () => {
    expect(isHealthPath('/api/enqueue')).toBe(false)
  })

  it('does not match an undefined path', () => {
    expect(isHealthPath(undefined)).toBe(false)
  })
})

describe('shouldRefuse under role: worker', () => {
  it('allows the bare health path', () => {
    expect(shouldRefuse('worker', '/_concierge/health')).toBe(false)
  })

  it('allows the health path with a trailing slash', () => {
    expect(shouldRefuse('worker', '/_concierge/health/')).toBe(false)
  })

  it('allows the health path with a query string', () => {
    expect(shouldRefuse('worker', '/_concierge/health?x=1')).toBe(false)
  })

  it('refuses a different route that merely shares the string prefix', () => {
    expect(shouldRefuse('worker', '/_concierge/healthz')).toBe(true)
  })

  it('refuses a deeper sub-path', () => {
    expect(shouldRefuse('worker', '/_concierge/health/sub')).toBe(true)
  })

  it('refuses a case-differing variant', () => {
    expect(shouldRefuse('worker', '/_CONCIERGE/Health')).toBe(true)
  })

  it('refuses an ordinary application route', () => {
    expect(shouldRefuse('worker', '/api/enqueue')).toBe(true)
  })

  it('refuses an undefined path, failing closed', () => {
    expect(shouldRefuse('worker', undefined)).toBe(true)
  })
})

describe('shouldRefuse under role: web and role: both', () => {
  it('role web never refuses the health route', () => {
    expect(shouldRefuse('web', '/_concierge/health')).toBe(false)
  })

  it('role web never refuses an ordinary application route', () => {
    expect(shouldRefuse('web', '/api/enqueue')).toBe(false)
  })

  it('role web never refuses an undefined path', () => {
    expect(shouldRefuse('web', undefined)).toBe(false)
  })

  it('role both never refuses the health route', () => {
    expect(shouldRefuse('both', '/_concierge/health')).toBe(false)
  })

  it('role both never refuses an ordinary application route', () => {
    expect(shouldRefuse('both', '/api/enqueue')).toBe(false)
  })

  it('role both never refuses an undefined path', () => {
    expect(shouldRefuse('both', undefined)).toBe(false)
  })
})

describe('shouldRefuse under an unresolved role (fail-closed default)', () => {
  // This is the regression test for the actual bug: previously the role was
  // derived from getSupervisor()?.config.role, which is undefined for the
  // entire pre-boot window, so an unresolved role failed OPEN and served
  // application routes on a process whose job is not to serve them. It must
  // now fail CLOSED, while still allowing the health route so orchestrators
  // and the lifecycle harness can detect readiness.
  it('refuses an ordinary application route', () => {
    expect(shouldRefuse(undefined, '/api/enqueue')).toBe(true)
  })

  it('refuses a different route that merely shares the health string prefix', () => {
    expect(shouldRefuse(undefined, '/_concierge/healthz')).toBe(true)
  })

  it('refuses an undefined path', () => {
    expect(shouldRefuse(undefined, undefined)).toBe(true)
  })

  it('still allows the health route', () => {
    expect(shouldRefuse(undefined, '/_concierge/health')).toBe(false)
  })
})

describe('resolveGateRole', () => {
  it('resolves the role from env', () => {
    expect(resolveGateRole({ env: 'worker', config: 'web', isDev: false })).toBe('worker')
  })

  it('falls back to config when env is absent', () => {
    expect(resolveGateRole({ env: undefined, config: 'both', isDev: false })).toBe('both')
  })

  it('defaults to both in dev when neither env nor config is set', () => {
    expect(resolveGateRole({ env: undefined, config: undefined, isDev: true })).toBe('both')
  })

  it('defaults to web in production when neither env nor config is set', () => {
    expect(resolveGateRole({ env: undefined, config: undefined, isDev: false })).toBe('web')
  })

  it('returns undefined rather than throwing for an invalid env value', () => {
    expect(resolveGateRole({ env: 'workers', config: undefined, isDev: false })).toBeUndefined()
  })

  it('returns undefined rather than throwing for an invalid config value', () => {
    expect(resolveGateRole({ env: undefined, config: 'workers', isDev: false })).toBeUndefined()
  })
})
