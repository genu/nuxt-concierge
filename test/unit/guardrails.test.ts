import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkGuardrails, guardrailDiagnostics, logger, startNoWorkerWatch } from '../../src/runtime/server/guardrails'
import type { SupervisorState, WorkerRecord } from '../../src/runtime/server/types'

const base = {
  role: 'both' as const,
  capabilities: { persistent: true, crossProcess: true },
  driverName: 'bullmq',
  queueCount: 1,
  isProduction: false,
  shutdownTimeout: 20_000,
  nitroShutdownTimeout: 30_000,
  nitroShutdownDisabled: false,
  preset: 'node-server',
}

describe('guardrails', () => {
  it('passes a sane configuration', () => {
    expect(guardrailDiagnostics(base)).toEqual([])
  })

  it('throws for a non-crossProcess driver outside role: both', () => {
    // Derived from capability, not driver name, so it covers memory+worker and
    // sync+worker with one rule and any future driver for free.
    expect(() => checkGuardrails({
      ...base,
      role: 'worker',
      driverName: 'memory',
      capabilities: { persistent: false, crossProcess: false },
    })).toThrow(/memory.*cannot be used with role "worker"/)
  })

  it('rule 1 message names the driver, the offending role, and both escapes', () => {
    // Actionable from the message alone: CONCIERGE_ROLE is called out
    // specifically because in a deployed setting that is where role usually
    // comes from, not the config file.
    const d = guardrailDiagnostics({
      ...base,
      role: 'worker',
      driverName: 'memory',
      capabilities: { persistent: false, crossProcess: false },
    })
    const fatal = d.find(x => x.level === 'error')
    expect(fatal).toBeDefined()
    expect(fatal?.message).toMatch(/"memory"/)
    expect(fatal?.message).toMatch(/role "worker"/)
    expect(fatal?.message).toMatch(/role:\s*'both'/)
    expect(fatal?.message).toMatch(/CONCIERGE_ROLE=both/)
    expect(fatal?.message).toMatch(/bullmq/)
  })

  it('allows a non-crossProcess driver under role: both', () => {
    expect(() => checkGuardrails({
      ...base,
      role: 'both',
      driverName: 'memory',
      capabilities: { persistent: false, crossProcess: false },
    })).not.toThrow()
  })

  it('warns but does not throw for a non-persistent driver in production', () => {
    const d = guardrailDiagnostics({
      ...base,
      isProduction: true,
      capabilities: { persistent: false, crossProcess: true },
    })
    expect(d.some(x => x.level === 'warn' && /persist/i.test(x.message))).toBe(true)
    expect(d.some(x => x.level === 'error')).toBe(false)
  })

  it('warns when a worker has no queues configured', () => {
    const d = guardrailDiagnostics({ ...base, role: 'worker', queueCount: 0 })
    expect(d.some(x => /no queues/i.test(x.message))).toBe(true)
  })

  it('warns when shutdownTimeout is not below NITRO_SHUTDOWN_TIMEOUT', () => {
    const d = guardrailDiagnostics({ ...base, shutdownTimeout: 30_000, nitroShutdownTimeout: 30_000 })
    expect(d.some(x => /NITRO_SHUTDOWN_TIMEOUT/.test(x.message))).toBe(true)
  })

  it('warns loudly when NITRO_SHUTDOWN_DISABLED is set', () => {
    // Close hooks never fire, so the drain silently never runs and every
    // deploy drops in-flight jobs.
    const d = guardrailDiagnostics({ ...base, nitroShutdownDisabled: true })
    expect(d.some(x => /NITRO_SHUTDOWN_DISABLED/.test(x.message))).toBe(true)
  })

  it('warns on a serverless preset with a non-persistent driver', () => {
    const d = guardrailDiagnostics({
      ...base,
      preset: 'vercel',
      capabilities: { persistent: false, crossProcess: true },
    })
    expect(d.some(x => /serverless/i.test(x.message))).toBe(true)
  })
})

const workerRecord = (queues: string[]): WorkerRecord => ({
  id: 'w1',
  hostname: 'h',
  pid: 1,
  role: 'worker',
  queues,
  concurrency: {},
  version: '1',
  startedAt: 0,
  lastHeartbeat: 0,
  state: 'running',
  active: [],
})

interface FakeSupervisorOptions {
  state?: SupervisorState
  queues?: Record<string, number>
  workers?: WorkerRecord[]
  depths?: Record<string, number>
}

/**
 * Matches the shape other test files use (e.g. shutdown.test.ts's
 * fakeSupervisor): a plain object with just the fields the function under
 * test reads, cast with `as never` at the call site rather than satisfying
 * the full Supervisor interface.
 */
const fakeSupervisor = (opts: FakeSupervisorOptions = {}) => ({
  getState: vi.fn((): SupervisorState => opts.state ?? 'running'),
  config: { worker: { queues: opts.queues ?? { default: 1 } } },
  driver: {
    workers: vi.fn(async (): Promise<WorkerRecord[]> => opts.workers ?? []),
    depth: vi.fn(async (queue: string): Promise<number> => opts.depths?.[queue] ?? 0),
  },
})

describe('startNoWorkerWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('warns when a queue has depth and no live worker claims it', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const s = fakeSupervisor({ depths: { default: 3 }, workers: [] })
    const stop = startNoWorkerWatch(s as never)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/Queue "default"/)
    stop()
  })

  it('does not warn when a live worker claims the queue', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const s = fakeSupervisor({ depths: { default: 3 }, workers: [workerRecord(['default'])] })
    const stop = startNoWorkerWatch(s as never)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(warnSpy).not.toHaveBeenCalled()
    stop()
  })

  it('does not warn when depth is zero', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const s = fakeSupervisor({ depths: { default: 0 }, workers: [] })
    const stop = startNoWorkerWatch(s as never)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(warnSpy).not.toHaveBeenCalled()
    stop()
  })

  it('does not warn when the supervisor is not in the running state', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const s = fakeSupervisor({ state: 'starting', depths: { default: 3 }, workers: [] })
    const stop = startNoWorkerWatch(s as never)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(warnSpy).not.toHaveBeenCalled()
    stop()
  })

  it('does not warn when the registry read throws', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const s = fakeSupervisor({ depths: { default: 3 } })
    s.driver.workers = vi.fn(async () => { throw new Error('registry down') })
    const stop = startNoWorkerWatch(s as never)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(warnSpy).not.toHaveBeenCalled()
    expect(debugSpy).toHaveBeenCalled()
    stop()
  })

  it('throttles a repeat warning for the same queue but still allows a different queue to warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const s = fakeSupervisor({
      queues: { default: 1, mail: 1 },
      depths: { default: 3, mail: 0 },
      workers: [],
    })
    const stop = startNoWorkerWatch(s as never)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // Still well within the 10-minute throttle window for "default": a
    // second tick must not warn again for it.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // "mail" starts having due work now — its own throttle state is
    // independent of "default"'s and must not be suppressed by it.
    s.driver.depth = vi.fn(async (queue: string) => (queue === 'mail' ? 5 : 3))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls[1]?.[0]).toMatch(/Queue "mail"/)

    stop()
  })

  it('the returned stop function clears the timer', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const s = fakeSupervisor({ depths: { default: 3 }, workers: [] })
    const stop = startNoWorkerWatch(s as never)

    stop()
    await vi.advanceTimersByTimeAsync(600_000)

    expect(warnSpy).not.toHaveBeenCalled()
  })
})
