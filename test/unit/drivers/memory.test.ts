import { describe, it, expect, afterEach, vi } from 'vitest'
import { createMemoryDriver, logger } from '../../../src/runtime/server/drivers/memory'
import type { ConciergeDriver } from '../../../src/runtime/server/drivers/types'
import type { WorkerRecord } from '../../../src/runtime/server/types'

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

const record = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id: 'w1',
  hostname: 'h',
  pid: 1,
  role: 'worker',
  queues: ['default'],
  concurrency: { default: 1 },
  version: 'test',
  startedAt: Date.now(),
  lastHeartbeat: Date.now(),
  state: 'running',
  active: [],
  ...over,
})

// Every consumer created via a driver's `consume()` keeps polling every
// POLL_MS until it is stopped, so any driver we create here must be closed
// once the test is done or it leaks a recurring timer for the rest of the
// process. Explicit close()/drain() calls that exist below are testing
// behaviour, not just cleanup — keep those as they are.
const drivers: ConciergeDriver[] = []
const makeDriver = (): ConciergeDriver => {
  const d = createMemoryDriver()
  drivers.push(d)
  return d
}

afterEach(async () => {
  await Promise.all(drivers.splice(0).map(d => d.close(true)))
})

describe('memory driver', () => {
  it('reports its capabilities honestly', () => {
    expect(createMemoryDriver().capabilities).toEqual({ persistent: false, crossProcess: false, history: 'bounded' })
  })

  it('processes an enqueued job through a consumer', async () => {
    const d = makeDriver()
    await d.init()
    const seen: string[] = []
    d.consume('default', { concurrency: 1 }, async ctx => { seen.push(ctx.name) })

    await d.enqueue('default', { name: 'work', payload: { a: 1 } })
    await tick(50)

    expect(seen).toEqual(['work'])
  })

  it('respects concurrency', async () => {
    const d = makeDriver()
    await d.init()
    let inFlight = 0
    let peak = 0
    d.consume('default', { concurrency: 2 }, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick(40)
      inFlight--
    })

    for (let i = 0; i < 6; i++) await d.enqueue('default', { name: 'j', payload: {} })
    await tick(300)

    expect(peak).toBe(2)
  })

  it('reports depth for pending jobs', async () => {
    const d = makeDriver()
    await d.init()
    await d.enqueue('default', { name: 'j', payload: {} })
    await d.enqueue('default', { name: 'j', payload: {} })

    expect(await d.depth('default')).toBe(2)
  })

  it('pause stops fetching but resolves immediately while a job is active', async () => {
    const d = makeDriver()
    await d.init()
    let started = 0
    const c = d.consume('default', { concurrency: 1 }, async () => {
      started++
      await tick(120)
    })

    await d.enqueue('default', { name: 'slow', payload: {} })
    await d.enqueue('default', { name: 'never', payload: {} })
    await tick(30)

    const before = Date.now()
    await c.pause()
    // Must not have waited for the 120ms job.
    expect(Date.now() - before).toBeLessThan(60)
    expect(c.activeCount()).toBe(1)

    await c.drain()
    expect(c.activeCount()).toBe(0)
    expect(started).toBe(1) // the second job was never fetched
  })

  it('drain resolves once in-flight reaches zero', async () => {
    const d = makeDriver()
    await d.init()
    const c = d.consume('default', { concurrency: 1 }, async () => { await tick(60) })
    await d.enqueue('default', { name: 'j', payload: {} })
    await tick(20)

    await c.pause()
    await c.drain()

    expect(c.activeCount()).toBe(0)
  })

  it('exposes active jobs while running', async () => {
    const d = makeDriver()
    await d.init()
    const c = d.consume('default', { concurrency: 1 }, async () => { await tick(80) })
    await d.enqueue('default', { name: 'visible', payload: {} })
    await tick(30)

    const active = c.active()
    expect(active).toHaveLength(1)
    expect(active[0]!.name).toBe('visible')
    expect(active[0]!.queue).toBe('default')

    await c.close(true)
  })

  it('stores and expires worker records by TTL', async () => {
    const d = makeDriver()
    await d.init()

    await d.heartbeat(record({ id: 'alive' }), 10_000)
    await d.heartbeat(record({ id: 'stale', lastHeartbeat: Date.now() - 60_000 }), 10_000)

    const ids = (await d.workers()).map(w => w.id)
    expect(ids).toContain('alive')
    expect(ids).not.toContain('stale')
  })

  it('deregisters a worker record', async () => {
    const d = makeDriver()
    await d.init()
    await d.heartbeat(record({ id: 'w9' }), 10_000)
    await d.deregister('w9')

    expect(await d.workers()).toEqual([])
  })

  it('retries a failing job up to the configured attempts', async () => {
    // Retries and the terminal failure both log; keep this test's output
    // clean since the logging itself is covered separately below.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const d = makeDriver()
    await d.init()
    let attempts = 0
    d.consume('default', { concurrency: 1 }, async () => {
      attempts++
      throw new Error('always fails')
    })

    await d.enqueue('default', { name: 'bad', payload: {}, attempts: 3 })
    await tick(300)

    expect(attempts).toBe(3)

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('driver.close(false) drains an active job before resolving', async () => {
    const d = makeDriver()
    await d.init()
    d.consume('default', { concurrency: 1 }, async () => { await tick(80) })
    await d.enqueue('default', { name: 'slow', payload: {} })
    await tick(20)

    const before = Date.now()
    await d.close(false)
    // The job had ~60ms left to run; close(false) must have waited for it.
    expect(Date.now() - before).toBeGreaterThanOrEqual(50)
  })

  it('driver.close(true) does not wait for an active job', async () => {
    const d = makeDriver()
    await d.init()
    const c = d.consume('default', { concurrency: 1 }, async () => { await tick(120) })
    await d.enqueue('default', { name: 'slow', payload: {} })
    await tick(30)

    const before = Date.now()
    await d.close(true)
    expect(Date.now() - before).toBeLessThan(60)
    expect(c.activeCount()).toBe(1)
  })

  it('retries a job whose handler rejects with null instead of an Error', async () => {
    // `run` is invoked as `void run(job)` (fire-and-forget), so a TypeError
    // thrown while reading `.retryable` off a non-object rejection would
    // become an unhandled rejection that can crash the process, with the job
    // neither retried nor logged. Rejecting with `null`/`undefined` is
    // unusual application code, but must not be fatal to the worker.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    const d = makeDriver()
    await d.init()
    let attempts = 0
    d.consume('default', { concurrency: 1 }, async () => {
      attempts++
      // Deliberately non-Error rejection: this is what the fix under test
      // (memory.ts) must survive.
      throw null
    })

    await d.enqueue('default', { name: 'bad', payload: {}, attempts: 3 })
    await tick(300)

    process.off('unhandledRejection', unhandled)

    expect(attempts).toBe(3)
    expect(unhandled).not.toHaveBeenCalled()

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('logs a terminally failed job instead of swallowing it', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const d = makeDriver()
    await d.init()
    let attempts = 0
    d.consume('default', { concurrency: 1 }, async () => {
      attempts++
      throw new Error('always fails')
    })

    await d.enqueue('default', { name: 'bad', payload: {}, attempts: 3 })
    await tick(300)

    expect(attempts).toBe(3)
    // Two retries logged as warnings, one final failure logged as an error.
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const [message] = errorSpy.mock.calls[0] as unknown as [string]
    expect(message).toContain('failed after 3 attempt(s)')

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
