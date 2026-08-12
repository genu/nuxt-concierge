import { describe, it, expect } from 'vitest'
import { createConnectionHealth } from '../../../src/runtime/server/drivers/bullmq'

describe('createConnectionHealth', () => {
  it('starts healthy, so init() never has to block on connectivity to report a sane default', () => {
    expect(createConnectionHealth().isHealthy()).toBe(true)
  })

  it('flips to unhealthy on a connection-level error', () => {
    const health = createConnectionHealth()

    health.onError()

    expect(health.isHealthy()).toBe(false)
  })

  it('flips back to healthy once the connection reports ready again', () => {
    const health = createConnectionHealth()

    health.onError()
    health.onReady()

    expect(health.isHealthy()).toBe(true)
  })

  it('a repeated error does not need a matching repeated ready to be undone by a later single ready', () => {
    const health = createConnectionHealth()

    health.onError()
    health.onError()
    health.onReady()

    expect(health.isHealthy()).toBe(true)
  })

  it('a stray ready with no prior error is a no-op, not a signal', () => {
    const health = createConnectionHealth()

    health.onReady()

    expect(health.isHealthy()).toBe(true)
  })
})
