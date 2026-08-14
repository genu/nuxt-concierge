import { describe, it, expect, afterEach, vi } from 'vitest'
import { createMemoryDriver, logger } from '../../../src/runtime/server/drivers/memory'
import type { ConciergeDriver, Consumer } from '../../../src/runtime/server/drivers/types'

const settle = async (predicate: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  // `await` here (not just a bare call) because every predicate below is
  // itself async, returning a Promise. A bare `!predicate()` treats that
  // Promise object as truthy and short-circuits the loop on the very first
  // check, before the driver's claim loop has had a single tick to run.
  while (!(await predicate()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
}

describe('memory driver terminal history', () => {
  let driver: ConciergeDriver
  let consumer: Consumer | undefined

  afterEach(async () => {
    if (consumer) await consumer.close(true)
    consumer = undefined
    await driver?.close(true)
  })

  it('retains a completed job', async () => {
    driver = createMemoryDriver()
    await driver.init()
    driver.registerHandler('q', 'ok', () => {})
    consumer = driver.consume('q', { concurrency: 1 })

    await driver.enqueue('q', { name: 'ok', payload: { a: 1 } })
    await settle(() => driver.introspect!.counts('q').then(c => c.completed === 1) as never)
    const counts = await driver.introspect!.counts('q')

    expect(counts.completed).toBe(1)
    expect(counts.failed).toBe(0)
  })

  it('retains a permanently failed job with its reason', async () => {
    // The terminal failure logs via `logger.error`; keep this test's output
    // clean since the logging itself is covered separately in memory.test.ts.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

    driver = createMemoryDriver()
    await driver.init()
    driver.registerHandler('q', 'bad', () => { throw new Error('boom') })
    consumer = driver.consume('q', { concurrency: 1 })

    await driver.enqueue('q', { name: 'bad', payload: {}, attempts: 1 })

    let listed: Awaited<ReturnType<NonNullable<ConciergeDriver['introspect']>['list']>> | undefined
    await settle((async () => {
      listed = await driver.introspect!.list('q', 'failed', { offset: 0, limit: 10 })
      return listed.items.length === 1
    }) as never)

    expect(listed!.items).toHaveLength(1)
    expect(listed!.items[0]!.state).toBe('failed')
    expect(listed!.items[0]!.failedReason).toContain('boom')
    // Attempts MADE, not a retry count. attempts: 1 means one attempt total.
    expect(listed!.items[0]!.attemptsMade).toBe(1)

    errorSpy.mockRestore()
  })

  it('evicts oldest-first at the configured limit', async () => {
    driver = createMemoryDriver({ historyLimit: 2 })
    await driver.init()
    driver.registerHandler('q', 'ok', () => {})
    consumer = driver.consume('q', { concurrency: 1 })

    for (const seq of [1, 2, 3]) await driver.enqueue('q', { name: 'ok', payload: { seq } })
    await settle((async () => {
      const c = await driver.introspect!.counts('q')
      return c.completed === 2 && (await driver.introspect!.counts('q')).waiting === 0
    }) as never)

    const listed = await driver.introspect!.list('q', 'completed', { offset: 0, limit: 10 })

    // Exactly 2, not ">= 2": a limit that is not enforced would give 3, and a
    // buffer that drops everything would give 0. Both must fail here.
    expect(listed.items).toHaveLength(2)
    expect(listed.total).toBe(2)
    // Oldest-first eviction: mem-1 is gone, mem-2 and mem-3 survive. Asserting
    // only the LENGTH would pass on a buffer that evicts the newest.
    expect(listed.items.map(j => j.id)).not.toContain('mem-1')
    expect(listed.items.map(j => j.id)).toEqual(expect.arrayContaining(['mem-2', 'mem-3']))
  })

  it('still resolves a surviving record by id after others were evicted', async () => {
    driver = createMemoryDriver({ historyLimit: 2 })
    await driver.init()
    driver.registerHandler('q', 'ok', () => {})
    consumer = driver.consume('q', { concurrency: 1 })

    for (const seq of [1, 2, 3]) await driver.enqueue('q', { name: 'ok', payload: { seq } })
    // Also requires `waiting === 0` (not just `completed === 2`), same as the
    // eviction test above: jobs are dequeued one at a time on a 10ms poll, so
    // `completed` reaches 2 as soon as mem-1/mem-2 finish — before mem-3 is
    // even dequeued. Without this guard the check can pass while mem-3 is
    // still queued and mem-1 hasn't been evicted yet, since the buffer sits
    // exactly at (not over) the limit until the third record is pushed.
    await settle((async () => {
      const c = await driver.introspect!.counts('q')
      return c.completed === 2 && c.waiting === 0
    }) as never)

    // The half that catches an eviction which corrupts the index rather than
    // merely dropping a row. A length assertion alone cannot see that.
    const survivor = await driver.introspect!.get('q', 'mem-3')
    expect(survivor).toBeDefined()
    expect(survivor!.id).toBe('mem-3')

    const evicted = await driver.introspect!.get('q', 'mem-1')
    expect(evicted).toBeUndefined()
  })
})
