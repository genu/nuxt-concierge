import { describe, it, expect } from 'vitest'
import { buildOverview } from '../../../src/runtime/server/introspect'
import type { Supervisor } from '../../../src/runtime/server/supervisor'

const fakeSupervisor = (over: Partial<{
  state: string
  driverName: string
  healthy: boolean
  history: 'durable' | 'bounded' | 'none'
  introspectable: boolean
  workers: Array<{ id: string, lastHeartbeat: number }>
}> = {}) => ({
  getState: () => over.state ?? 'running',
  config: {
    role: 'both',
    version: '1.2.3',
    worker: { queues: { default: 5 }, heartbeatTtl: 15_000 },
  },
  consumers: new Map(),
  driver: {
    name: over.driverName ?? 'memory',
    isHealthy: () => over.healthy ?? true,
    capabilities: {
      persistent: false,
      crossProcess: false,
      history: over.history ?? 'bounded',
    },
    introspect: (over.introspectable ?? true)
      ? {
          counts: async () => ({ waiting: 1, active: 0, completed: 2, failed: 3, delayed: 0 }),
          list: async () => ({ items: [], total: 0 }),
          get: async () => undefined,
          retry: async () => {},
        }
      : undefined,
    workers: async () => over.workers ?? [],
  },
} as unknown as Supervisor)

describe('buildOverview', () => {
  it('reports "absent" rather than a supervisor state when there is no supervisor', async () => {
    const result = await buildOverview(undefined)

    // NOT 'stopped': the supervisor may never have existed at all (mid-boot),
    // and SupervisorState gets no new member for a case that only exists when
    // there IS no supervisor. Same reasoning as health.ts's `ready: false`.
    expect(result.state).toBe('absent')
    expect(result.queues).toEqual([])
    expect(result.introspectable).toBe(false)
  })

  it('flags a driver with no introspection instead of returning empty counts', async () => {
    const result = await buildOverview(fakeSupervisor({ introspectable: false, history: 'none' }))

    // Both halves. `introspectable: false` is what lets the UI say "this driver
    // cannot do this" rather than rendering a confident empty table; and the
    // queue must still be LISTED, so the UI can name it.
    expect(result.introspectable).toBe(false)
    expect(result.queues.map(q => q.name)).toEqual(['default'])
    expect(result.queues[0]!.counts).toBeUndefined()
  })

  it('carries the history capability through so the UI can label evictions', async () => {
    const result = await buildOverview(fakeSupervisor({ history: 'bounded' }))
    expect(result.capabilities.history).toBe('bounded')
  })

  it('reports an unhealthy driver without omitting the counts it last read', async () => {
    const result = await buildOverview(fakeSupervisor({ healthy: false }))

    // Both halves: the flag must be false AND the counts must still be present,
    // so the UI can show a banner over stale data rather than a blank panel.
    expect(result.driverHealthy).toBe(false)
    expect(result.queues[0]!.counts).toMatchObject({ failed: 3 })
  })

  it('marks a worker whose heartbeat is older than heartbeatTtl as stale', async () => {
    const fresh = { id: 'a', lastHeartbeat: Date.now(), active: [] }
    const old = { id: 'b', lastHeartbeat: Date.now() - 60_000, active: [] }
    const result = await buildOverview(fakeSupervisor({ workers: [fresh, old] as never }))

    // Computed server-side, per the "SPA holds no business logic" rule. Both
    // halves asserted: a rule marking EVERYTHING stale would pass on the
    // second assertion alone.
    expect(result.workers.find(w => w.id === 'a')!.stale).toBe(false)
    expect(result.workers.find(w => w.id === 'b')!.stale).toBe(true)
  })
})
