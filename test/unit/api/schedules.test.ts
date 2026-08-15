import { describe, expect, it, vi } from 'vitest'
import { DriverReadTimeoutError, readSchedules } from '../../../src/runtime/server/introspect'
import type { ScheduleSummary } from '../../../src/runtime/server/drivers/types'

describe('readSchedules', () => {
  it('returns the driver list', async () => {
    const schedule = { list: vi.fn().mockResolvedValue([{ id: 'a' }]), upsert: vi.fn(), remove: vi.fn() }
    await expect(readSchedules(schedule, 'memory', 'default')).resolves.toEqual([{ id: 'a' }])
  })

  it('throws DriverReadTimeoutError when the driver hangs', async () => {
    // A dead-Redis command never rejects — it sits in ioredis's offline queue
    // and never settles at all, because BullMQ requires
    // `maxRetriesPerRequest: null`. Without this bound the Schedules panel
    // hangs forever instead of showing the unhealthy state.
    const schedule = { list: vi.fn(() => new Promise<ScheduleSummary[]>(() => {})), upsert: vi.fn(), remove: vi.fn() }
    await expect(readSchedules(schedule, 'bullmq', 'default', 10))
      .rejects.toBeInstanceOf(DriverReadTimeoutError)
  })

  it('names the driver and the bound in the timeout message', async () => {
    const schedule = { list: vi.fn(() => new Promise<ScheduleSummary[]>(() => {})), upsert: vi.fn(), remove: vi.fn() }
    await expect(readSchedules(schedule, 'bullmq', 'default', 10))
      .rejects.toThrow(/bullmq driver did not respond within 10ms/)
  })
})
