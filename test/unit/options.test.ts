import { describe, it, expect } from 'vitest'
import { moduleDefaults, resolveModuleOptions } from '../../src/options'

describe('resolveModuleOptions', () => {
  it('fills every worker field when the user supplies only one', () => {
    const resolved = resolveModuleOptions({ worker: { queues: { mail: 2 } } })

    expect(resolved.worker.queues).toEqual({ mail: 2 })
    expect(resolved.worker.shutdownTimeout).toBe(moduleDefaults.worker.shutdownTimeout)
    expect(resolved.worker.heartbeatInterval).toBe(moduleDefaults.worker.heartbeatInterval)
    expect(resolved.worker.heartbeatTtl).toBe(moduleDefaults.worker.heartbeatTtl)
  })

  it('does not merge the user queue map into the default one', () => {
    // defu merges objects by default, which would leave the `default` queue
    // declared even though the user replaced the map — and a stray declared
    // queue silently starts a consumer for work that never arrives.
    const resolved = resolveModuleOptions({ worker: { queues: { mail: 2 } } })

    expect(Object.keys(resolved.worker.queues)).toEqual(['mail'])
  })

  it('fills every bullmq field when the user supplies only one', () => {
    const resolved = resolveModuleOptions({ bullmq: { stalledInterval: 1000 } })

    expect(resolved.bullmq.stalledInterval).toBe(1000)
    expect(resolved.bullmq.maxStalledCount).toBe(moduleDefaults.bullmq.maxStalledCount)
  })

  it('returns the defaults verbatim for empty input', () => {
    expect(resolveModuleOptions({})).toEqual(moduleDefaults)
  })

  it('fills backoff.delay when the user overrides only the type', () => {
    // `defaults.backoff` is partial at BOTH levels. Before that, this object
    // failed to typecheck with "Property 'delay' is missing" even though the
    // resolver fills it — so the assertion below is as much about the type
    // compiling as about the value.
    const resolved = resolveModuleOptions({ defaults: { backoff: { type: 'fixed' } } })

    expect(resolved.defaults.backoff.type).toBe('fixed')
    expect(resolved.defaults.backoff.delay).toBe(moduleDefaults.defaults.backoff.delay)
  })

  it('fills backoff.type when the user overrides only the delay', () => {
    const resolved = resolveModuleOptions({ defaults: { backoff: { delay: 250 } } })

    expect(resolved.defaults.backoff.delay).toBe(250)
    expect(resolved.defaults.backoff.type).toBe(moduleDefaults.defaults.backoff.type)
  })

  it('fills backoff wholesale when the user overrides only attempts', () => {
    const resolved = resolveModuleOptions({ defaults: { attempts: 7 } })

    expect(resolved.defaults.attempts).toBe(7)
    expect(resolved.defaults.backoff).toEqual(moduleDefaults.defaults.backoff)
  })
})
