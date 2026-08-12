import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSupervisor, resetSupervisor } from '../../src/runtime/server/supervisor'

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
  jobs: [{ name: 'work', queue: 'default', handler: async () => {} }],
  version: 'test-1',
}

afterEach(() => { resetSupervisor() })

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

  it('produces a worker record that snapshots active jobs', async () => {
    const s = await createSupervisor(baseConfig)
    await s.startConsumers()

    const record = s.record()
    expect(record.role).toBe('both')
    expect(record.queues).toEqual(['default'])
    expect(record.concurrency).toEqual({ default: 2 })
    expect(record.version).toBe('test-1')
    expect(record.state).toBe('running')
    expect(Array.isArray(record.active)).toBe(true)

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

    vi.useRealTimers()
    await s.stop()
    expect(gone).toHaveBeenCalledWith(s.id)
  })

  it('reports state "draining" in the record once draining', async () => {
    const s = await createSupervisor(baseConfig)
    await s.startConsumers()
    s.setState('draining')

    expect(s.record().state).toBe('draining')
    await s.stop()
  })
})
