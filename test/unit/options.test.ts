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

  describe('memory.historyLimit validation', () => {
    // -1 is the case that actually hangs a process: memory.ts's eviction loop
    // is `while (bucket.length > historyLimit) bucket.shift()`, and
    // `shift()` on an empty array leaves `length` at 0, so `0 > -1` never
    // becomes false.
    it('throws a loud, actionable error for -1', () => {
      expect(() => resolveModuleOptions({ memory: { historyLimit: -1 } }))
        .toThrow(/concierge\.memory\.historyLimit must be a positive integer, received -1/)
    })

    // 0 does not hang, but it would silently discard every terminal record —
    // still a config mistake that must be loud, not a silent no-history mode.
    it('throws for 0', () => {
      expect(() => resolveModuleOptions({ memory: { historyLimit: 0 } }))
        .toThrow(/received 0/)
    })

    // A fraction retains an off-by-one count rather than hanging, so it needs
    // its own rejection distinct from the negative/zero cases above.
    it('throws for a non-integer like 1.5', () => {
      expect(() => resolveModuleOptions({ memory: { historyLimit: 1.5 } }))
        .toThrow(/received 1\.5/)
    })

    it('does not coerce — a bad value throws rather than silently clamping', () => {
      // Guards against a "fix" that clamps to 1 instead of throwing: the spec
      // requires a loud boot-time error, not a silent substitution.
      expect(() => resolveModuleOptions({ memory: { historyLimit: -1 } })).toThrow()
      expect(() => resolveModuleOptions({ memory: { historyLimit: 0 } })).toThrow()
    })

    it('accepts a valid positive integer', () => {
      const resolved = resolveModuleOptions({ memory: { historyLimit: 250 } })
      expect(resolved.memory.historyLimit).toBe(250)
    })

    it('accepts the default when the user supplies nothing', () => {
      expect(() => resolveModuleOptions({})).not.toThrow()
      expect(resolveModuleOptions({}).memory.historyLimit).toBe(moduleDefaults.memory.historyLimit)
    })
  })

  describe('cron options', () => {
    it('defaults cron.enabled to true', () => {
      expect(resolveModuleOptions({}).cron.enabled).toBe(true)
    })

    it('lets a user disable cron without restating other config', () => {
      const resolved = resolveModuleOptions({ cron: { enabled: false } })
      expect(resolved.cron.enabled).toBe(false)
      // Asserted alongside, because a `cron` key that silently replaced rather
      // than merged would be the `worker.queues` defect in a new location.
      expect(resolved.defaults.attempts).toBe(3)
    })
  })
})
