import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSupervisor, resetSupervisor, getDriver } from '../../src/runtime/server/supervisor'

const baseConfig = {
  role: 'both' as const,
  driver: 'memory' as const,
  connection: {},
  bullmq: { maxStalledCount: 3, stalledInterval: 30_000 },
  worker: {
    queues: { default: 2 },
    shutdownTimeout: 20_000,
    heartbeatInterval: 5_000,
    heartbeatTtl: 15_000,
  },
  defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
  jobs: [{ name: 'work', queue: 'default', handler: async () => {} }],
  version: 'test-1',
  isProduction: false,
}

afterEach(async () => {
  // Real timers first: a test that left fake timers active would otherwise
  // make resetSupervisor()'s teardown (which itself schedules real-world
  // async work) hang or behave unpredictably.
  vi.useRealTimers()
  await resetSupervisor()
})

describe('supervisor', () => {
  it('starts in "starting" and reaches "running" after consumers start', async () => {
    const s = await createSupervisor(baseConfig)
    expect(s.getState()).toBe('starting')

    await s.startConsumers()
    expect(s.getState()).toBe('running')

    await s.stop()
  })

  it('starts one consumer per configured queue under role: worker', async () => {
    const s = await createSupervisor({
      ...baseConfig,
      role: 'worker',
      worker: { ...baseConfig.worker, queues: { default: 1, mail: 1 } },
      jobs: [
        { name: 'work', queue: 'default', handler: async () => {} },
        { name: 'send', queue: 'mail', handler: async () => {} },
      ],
    })
    await s.startConsumers()

    expect(s.consumers.size).toBe(2)
    await s.stop()
  })

  it('starts no consumers under role: web but still exists', async () => {
    const s = await createSupervisor({ ...baseConfig, role: 'web' })
    await s.startConsumers()

    expect(s.consumers.size).toBe(0)
    expect(s.getState()).toBe('running')
    await s.stop()
  })

  it('throws when a job names a queue absent from the concurrency map', async () => {
    await expect(createSupervisor({
      ...baseConfig,
      jobs: [{ name: 'orphan', queue: 'nope', handler: async () => {} }],
    })).rejects.toThrow(/"nope".*worker\.queues/)
  })

  it('builds a route map from name to queue', async () => {
    const s = await createSupervisor(baseConfig)
    expect(s.routes.get('work')).toBe('default')
    await s.stop()
  })

  it('produces a worker record with the configured role, queues and concurrency', async () => {
    const s = await createSupervisor(baseConfig)
    await s.startConsumers()

    const record = s.record()
    expect(record.role).toBe('both')
    expect(record.queues).toEqual(['default'])
    expect(record.concurrency).toEqual({ default: 2 })
    expect(record.version).toBe('test-1')
    expect(record.state).toBe('running')

    await s.stop()
  })

  it('snapshots an in-flight job by queue and name on record()', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    const s = await createSupervisor({
      ...baseConfig,
      jobs: [{ name: 'work', queue: 'default', handler: async () => { await gate } }],
    })
    await s.startConsumers()

    await s.driver.enqueue('default', { name: 'work', payload: {} })
    // The memory driver's claim loop polls every 10ms; give it a few ticks
    // to pick the job up and mark it active before we snapshot.
    await new Promise(resolve => setTimeout(resolve, 40))

    const active = s.record().active
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ queue: 'default', name: 'work' })
    expect(typeof active[0]?.jobId).toBe('string')
    expect(typeof active[0]?.startedAt).toBe('number')

    release()
    await s.stop()
  })

  it('writes heartbeats on an interval and deregisters on stop', async () => {
    vi.useFakeTimers()
    const s = await createSupervisor({
      ...baseConfig,
      worker: { ...baseConfig.worker, heartbeatInterval: 1000 },
    })
    const beat = vi.spyOn(s.driver, 'heartbeat')
    const gone = vi.spyOn(s.driver, 'deregister')

    await s.startConsumers()
    await vi.advanceTimersByTimeAsync(3500)
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(3)

    await s.stop()
    expect(gone).toHaveBeenCalledWith(s.id)
  })

  it('stops writing heartbeats once stopped', async () => {
    vi.useFakeTimers()
    const s = await createSupervisor({
      ...baseConfig,
      worker: { ...baseConfig.worker, heartbeatInterval: 1000 },
    })
    const beat = vi.spyOn(s.driver, 'heartbeat')

    await s.startConsumers()
    await vi.advanceTimersByTimeAsync(2500)
    const callsBeforeStop = beat.mock.calls.length
    expect(callsBeforeStop).toBeGreaterThan(0)

    await s.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(beat.mock.calls.length).toBe(callsBeforeStop)
  })

  it('stopHeartbeat waits for an in-flight write before resolving, so it cannot land after deregister', async () => {
    // Clearing the interval alone only stops FUTURE ticks — the most recent
    // tick may already have launched a fire-and-forget heartbeat write. If
    // stopHeartbeat() resolved without waiting for it, that write could land
    // after driver.deregister(id) and recreate the worker record with a
    // fresh TTL: the exact phantom-worker case this ordering exists to
    // prevent.
    const s = await createSupervisor({
      ...baseConfig,
      worker: { ...baseConfig.worker, heartbeatInterval: 20 },
    })

    let resolveGate!: () => void
    const gate = new Promise<void>((resolve) => { resolveGate = resolve })
    let calls = 0
    const original = s.driver.heartbeat.bind(s.driver)
    vi.spyOn(s.driver, 'heartbeat').mockImplementation(async (...args: Parameters<typeof original>) => {
      calls++
      // Hang the SECOND write (the first interval tick after the immediate
      // startup beat) until the test releases it.
      if (calls === 2) await gate
      return original(...args)
    })

    await s.startConsumers()
    // Let the interval fire once and start its (still-gated) write.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toBe(2)

    let settled = false
    const stopPromise = s.stopHeartbeat().then(() => { settled = true })

    // stopHeartbeat() must still be pending while the write it is tracking
    // is gated — resolving early here is exactly the bug.
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(settled).toBe(false)

    resolveGate()
    await stopPromise
    expect(settled).toBe(true)

    await s.stop()
  })

  it('reports state "draining" in the record once draining', async () => {
    const s = await createSupervisor(baseConfig)
    await s.startConsumers()
    s.setState('draining')

    expect(s.record().state).toBe('draining')
    await s.stop()
  })

  it('getDriver() returns the live driver and route map', async () => {
    const s = await createSupervisor(baseConfig)

    const { driver, routes } = getDriver()
    expect(driver).toBe(s.driver)
    expect(routes).toBe(s.routes)

    await s.stop()
  })
})
