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

  describe('defaults.attempts validation', () => {
    // `attempts` is TOTAL attempts including the first, so 0 reads as "never
    // run" and behaved as "run once": it is not nullish, so it survived
    // `entry.attempts ?? defaults.attempts`, and then bullmq's
    // `attemptsMade + 1 < 0` and memory's `job.attempt < 0` are both never
    // true. The drivers agreed, so no conformance test caught it — the value
    // was simply a lie with no guard.
    it('throws a loud, actionable error for 0', () => {
      expect(() => resolveModuleOptions({ defaults: { attempts: 0 } }))
        .toThrow(/concierge\.defaults\.attempts must be a positive integer, received 0/)
    })

    it('throws for a negative value', () => {
      expect(() => resolveModuleOptions({ defaults: { attempts: -1 } }))
        .toThrow(/received -1/)
    })

    // A fraction does not hang, but `attemptsMade + 1 < 2.5` retains an
    // off-by-one budget rather than the count the user wrote.
    it('throws for a non-integer like 2.5', () => {
      expect(() => resolveModuleOptions({ defaults: { attempts: 2.5 } }))
        .toThrow(/received 2\.5/)
    })

    it('does not coerce — a bad value throws rather than silently clamping to 1', () => {
      // Guards against a "fix" that substitutes 1 for 0. The issue asks for a
      // loud boot-time failure, because a user who wrote 0 meant something
      // this module cannot deliver and needs to be told so.
      expect(() => resolveModuleOptions({ defaults: { attempts: 0 } })).toThrow()
      expect(() => resolveModuleOptions({ defaults: { attempts: -1 } })).toThrow()
    })

    it('accepts 1, the smallest honest value', () => {
      expect(resolveModuleOptions({ defaults: { attempts: 1 } }).defaults.attempts).toBe(1)
    })

    it('accepts the default when the user supplies nothing', () => {
      expect(() => resolveModuleOptions({})).not.toThrow()
      expect(resolveModuleOptions({}).defaults.attempts).toBe(moduleDefaults.defaults.attempts)
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
