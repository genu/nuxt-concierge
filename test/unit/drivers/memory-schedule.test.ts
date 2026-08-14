import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDriver } from '../../../src/runtime/server/drivers/memory'
import { schedulerIdFor } from '../../../src/runtime/server/cron'

const spec = (jobName: string, expression = '0 * * * *') => ({
  id: schedulerIdFor(jobName), jobName, expression, tz: 'UTC',
})

afterEach(() => { vi.useRealTimers() })

describe('memory driver scheduling', () => {
  it('declares scheduling support', () => {
    expect(createMemoryDriver().schedule).toBeDefined()
  })

  it('lists an upserted schedule with its next fire time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T00:30:00Z'))

    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest'))

    const listed = await driver.schedule!.list('default')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: schedulerIdFor('digest'), jobName: 'digest', queue: 'default',
      expression: '0 * * * *', tz: 'UTC',
    })
    expect(new Date(listed[0]!.next!).toISOString()).toBe('2027-01-01T01:00:00.000Z')

    await driver.close(true)
  })

  it('is idempotent — two upserts of the same id yield one schedule', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest'))
    await driver.schedule!.upsert('default', spec('digest'))
    expect(await driver.schedule!.list('default')).toHaveLength(1)
    await driver.close(true)
  })

  it('updates in place when the expression changes', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest', '0 * * * *'))
    await driver.schedule!.upsert('default', spec('digest', '*/5 * * * *'))

    const listed = await driver.schedule!.list('default')
    // Both halves: one row, AND it is the new expression. "Length is 1" alone
    // passes for an implementation that ignores the second upsert entirely.
    expect(listed).toHaveLength(1)
    expect(listed[0]!.expression).toBe('*/5 * * * *')
    await driver.close(true)
  })

  it('scopes schedules to their queue', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('a', spec('one'))
    await driver.schedule!.upsert('b', spec('two'))
    expect(await driver.schedule!.list('a')).toHaveLength(1)
    expect(await driver.schedule!.list('b')).toHaveLength(1)
    await driver.close(true)
  })

  it('removes a schedule', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest'))
    await driver.schedule!.remove('default', schedulerIdFor('digest'))
    expect(await driver.schedule!.list('default')).toEqual([])
    await driver.close(true)
  })

  it('enqueues a job when the tick arrives, carrying the tick time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T00:59:59Z'))

    const driver = createMemoryDriver()
    const seen: Array<{ tick: number, expression: string, tz: string }> = []
    driver.registerHandler('default', 'digest', async (ctx) => { seen.push(ctx.cron!) })
    driver.consume('default', { concurrency: 1 })
    await driver.schedule!.upsert('default', spec('digest'))

    // Fake timers advance in lockstep with zero jitter, so a plain
    // `advanceTimersByTimeAsync` up to the fire time makes `Date.now()` at
    // fire time exactly equal the scheduled instant even in a buggy
    // implementation — the assertion below would pass either way. Jumping
    // the system clock forward before letting the pending timer actually run
    // simulates the real-world timer latency the comment describes, so a
    // handler reading `ctx.cron.tick` genuinely tells `current.next` (fixed
    // at arm time) apart from `Date.now()` (read when the timer fires).
    vi.setSystemTime(new Date('2027-01-01T01:00:05.500Z'))
    await vi.advanceTimersByTimeAsync(2_000)
    vi.useRealTimers()
    await new Promise(r => setTimeout(r, 60))

    expect(seen).toHaveLength(1)
    // The SCHEDULED time, not the time the handler started. Asserting the
    // exact instant is what catches an implementation that passes Date.now().
    expect(new Date(seen[0]!.tick).toISOString()).toBe('2027-01-01T01:00:00.000Z')
    expect(seen[0]!.expression).toBe('0 * * * *')
    expect(seen[0]!.tz).toBe('UTC')

    await driver.close(true)
  })

  it('stops firing after close', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest', '* * * * *'))
    await driver.close(true)
    expect(await driver.schedule!.list('default')).toEqual([])
  })
})
