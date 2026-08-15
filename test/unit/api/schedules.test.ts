import { describe, expect, it, vi } from 'vitest'
import { DriverReadTimeoutError, readSchedules } from '../../../src/runtime/server/introspect'
import { readAllSchedules } from '../../../src/runtime/server/routes/api/schedules-list'
import { runScheduleNow } from '../../../src/runtime/server/routes/api/schedules-run'
import type { DriverScheduling, EnqueueResult, ScheduleSummary } from '../../../src/runtime/server/drivers/types'

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

describe('readAllSchedules', () => {
  it('returns every queue\'s items with an empty unreadableQueues when all reads succeed', async () => {
    const schedule: DriverScheduling = {
      list: async (queue: string) => queue === 'mail'
        ? [{ id: 'a', jobName: 'send-email', queue: 'mail', expression: '* * * * *', tz: 'UTC' }]
        : [{ id: 'b', jobName: 'sweep', queue: 'default', expression: '0 * * * *', tz: 'UTC' }],
      upsert: vi.fn(),
      remove: vi.fn(),
    }

    const result = await readAllSchedules(schedule, 'memory', ['mail', 'default'])

    expect(result.items.map(i => i.id).sort()).toEqual(['a', 'b'])
    expect(result.unreadableQueues).toEqual([])
  })

  it('still returns a healthy queue\'s items, naming the one that hung, instead of failing the whole request', async () => {
    // Before this fix, one hanging queue's `readSchedules` rejection propagated
    // out of a single outer `Promise.all` and took every other queue's
    // already-successful read down with it — the identical failure mode
    // `buildOverview` exists to avoid for `counts()`/`workers()`.
    const schedule: DriverScheduling = {
      list: async (queue: string) => queue === 'stuck'
        ? await new Promise<ScheduleSummary[]>(() => {})
        : [{ id: 'ok', jobName: 'sweep', queue: 'default', expression: '0 * * * *', tz: 'UTC' }],
      upsert: vi.fn(),
      remove: vi.fn(),
    }

    // A short injected timeout, not the real 1.5s default: a genuine
    // Promise.race against a promise that never settles, bounded by this
    // number rather than production's constant.
    const result = await readAllSchedules(schedule, 'bullmq', ['default', 'stuck'], 20)

    // Both halves matter together: the healthy queue's item must still be
    // present (fail-fast would have lost it), AND the hung queue must be
    // NAMED (silently dropping it would under-report with no explanation).
    expect(result.items).toEqual([{ id: 'ok', jobName: 'sweep', queue: 'default', expression: '0 * * * *', tz: 'UTC' }])
    expect(result.unreadableQueues).toEqual(['stuck'])
  })
})

describe('runScheduleNow', () => {
  it('resolves with the enqueue result on the happy path', async () => {
    const enqueue = vi.fn(() => Promise.resolve<EnqueueResult>({ id: 'mem-1', deduplicated: false }))
    await expect(runScheduleNow(enqueue, 'memory')).resolves.toEqual({ id: 'mem-1', deduplicated: false })
  })

  it('rejects with DriverReadTimeoutError instead of hanging forever against a dead driver', async () => {
    // Same shape as the jobs/schedules-list hang: `useQueue().enqueue()` ends
    // in a real driver write, and a dead-Redis connection never settles it —
    // it sits in ioredis's offline queue forever. Before this fix, the
    // dashboard's "Run now" button would hang silently instead of the route
    // resolving to a 503.
    const enqueue = vi.fn(() => new Promise<EnqueueResult>(() => {}))
    await expect(runScheduleNow(enqueue, 'bullmq', 10))
      .rejects.toBeInstanceOf(DriverReadTimeoutError)
  })

  it('names the driver and the bound in the timeout message', async () => {
    const enqueue = vi.fn(() => new Promise<EnqueueResult>(() => {}))
    await expect(runScheduleNow(enqueue, 'bullmq', 10))
      .rejects.toThrow(/bullmq driver did not respond within 10ms/)
  })
})
