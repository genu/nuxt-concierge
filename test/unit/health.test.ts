import { describe, it, expect } from 'vitest'
import { healthPayload, healthStatus } from '../../src/runtime/server/routes/health'

const supervisorAt = (state: string, driverHealthy = true) => ({
  getState: () => state,
  config: { role: 'worker', worker: { queues: { default: 5 } }, version: 'v1' },
  consumers: new Map([['default', { activeCount: () => 2, active: () => [] }]]),
  driver: { isHealthy: () => driverHealthy },
})

describe('health endpoint', () => {
  it('returns 200 only when running', () => {
    expect(healthStatus('running')).toBe(200)
  })

  it('returns 503 while starting, so readiness is false until consumers are up', () => {
    // Binding the HTTP listener is not readiness. A rolling deploy must not
    // route traffic to a process whose consumers have not started.
    expect(healthStatus('starting')).toBe(503)
  })

  it('returns 503 while draining and once stopped', () => {
    expect(healthStatus('draining')).toBe(503)
    expect(healthStatus('stopped')).toBe(503)
  })

  it('returns 503 when there is no supervisor at all', () => {
    expect(healthStatus(undefined)).toBe(503)
  })

  it('returns 503 when running but the driver connection is unhealthy', () => {
    // A worker whose Redis connection has died can be state: 'running' (it
    // booted fine) while unable to process anything. A rolling deploy must
    // not promote that instance just because it once became ready.
    expect(healthStatus('running', false)).toBe(503)
  })

  it('reports state, role, queues, activeCount, version and driverHealthy', () => {
    expect(healthPayload(supervisorAt('running') as never)).toEqual({
      state: 'running',
      role: 'worker',
      queues: ['default'],
      activeCount: 2,
      version: 'v1',
      driverHealthy: true,
    })
  })

  it('reports driverHealthy: false when the driver reports itself unhealthy', () => {
    expect(healthPayload(supervisorAt('running', false) as never)).toEqual({
      state: 'running',
      role: 'worker',
      queues: ['default'],
      activeCount: 2,
      version: 'v1',
      driverHealthy: false,
    })
  })
})
