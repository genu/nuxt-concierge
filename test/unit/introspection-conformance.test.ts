import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSyncDriver } from '../../src/runtime/server/drivers/sync'
import { createMemoryDriver } from '../../src/runtime/server/drivers/memory'
import { createBullmqDriver } from '../../src/runtime/server/drivers/bullmq'
import type { ConciergeDriver, Consumer } from '../../src/runtime/server/drivers/types'

/**
 * The `sync` driver's contract is ABSENCE, which is a stronger and different
 * claim than "calling it fails". A uniform interface returning empty arrays
 * would make "unsupported" indistinguishable from "genuinely empty", and the
 * UI would render a confident empty table that is a lie. This asserts the
 * type-level fact at runtime so a later "helpful" stub implementation breaks
 * this test rather than silently changing what the dashboard shows.
 */
describe('sync driver introspection', () => {
  it('declares no introspection at all', () => {
    const driver = createSyncDriver()
    expect(driver.introspect).toBeUndefined()
  })

  it('reports no history rather than an empty history', () => {
    const driver = createSyncDriver()
    expect(driver.capabilities.history).toBe('none')
  })
})

/**
 * One table, run against every driver that claims to introspect.
 *
 * Two independent test files is how depth() drifted between the drivers in an
 * earlier phase: the contract was undocumented and each file encoded its own
 * author's reading. This contract now has three implementations rather than
 * two, so the same discipline applies here. `sync` is deliberately absent —
 * see the block above.
 */
const INTROSPECTING_DRIVERS: Array<[string, () => ConciergeDriver]> = [
  ['memory', () => createMemoryDriver({ historyLimit: 50 })],
  // Only when a real Redis is available, exactly as retry-conformance.test.ts
  // does. Skipping silently is acceptable ONLY because the same table also
  // runs against `memory` unconditionally, so a broken table cannot pass
  // everywhere by being skipped everywhere. CI supplies REDIS_URL.
  ...(process.env.REDIS_URL
    ? [['bullmq', () => createBullmqDriver({
        connection: { url: process.env.REDIS_URL },
        bullmq: { maxStalledCount: 3, stalledInterval: 1000 },
      })] as [string, () => ConciergeDriver]]
    : []),
]

/** Per-process, so an interrupted run's leftovers cannot inflate the next run. */
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

describe.each(INTROSPECTING_DRIVERS)('%s driver introspection contract', (name, make) => {
  let driver: ConciergeDriver
  let consumer: Consumer | undefined
  const queueName = (label: string) => `introspect-${RUN_ID}-${name}-${label}`

  beforeEach(async () => {
    driver = make()
    await driver.init()
    consumer = undefined
  })

  afterEach(async () => {
    if (consumer) await consumer.close(true)
    await driver.close(true)
  })

  const until = async (predicate: () => Promise<boolean>, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise(r => setTimeout(r, 25))
    }
  }

  it('declares introspection and a history capability that is not "none"', () => {
    expect(driver.introspect).toBeDefined()
    // A driver implementing introspection while claiming no history would make
    // the UI hide the very panels this SPI exists to fill.
    expect(driver.capabilities.history).not.toBe('none')
  })

  it('counts a waiting job before any consumer exists', async () => {
    const queue = queueName('waiting')
    await driver.enqueue(queue, { name: 'ok', payload: { a: 1 } })

    const counts = await driver.introspect!.counts(queue)

    // Exactly 1 in waiting AND exactly 0 in active. The second half is what
    // catches a driver that reports every known job in every state.
    expect(counts.waiting).toBe(1)
    expect(counts.active).toBe(0)
    expect(counts.completed).toBe(0)
  })

  it('counts a delayed job as delayed, not as waiting', async () => {
    const queue = queueName('delayed')
    await driver.enqueue(queue, { name: 'ok', payload: {}, delay: 30_000 })

    const counts = await driver.introspect!.counts(queue)

    // Both halves: `delayed` must be 1 and `waiting` must be 0. This is the
    // same distinction depth() encodes, and asserting only `delayed >= 1`
    // would pass on a driver that double-counts into both.
    expect(counts.delayed).toBe(1)
    expect(counts.waiting).toBe(0)
  })

  it('lists a waiting job with its name, queue and state', async () => {
    const queue = queueName('list')
    await driver.enqueue(queue, { name: 'ok', payload: { a: 1 }, attempts: 3 })

    const { items, total } = await driver.introspect!.list(queue, 'waiting', { offset: 0, limit: 10 })

    expect(total).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]!.name).toBe('ok')
    expect(items[0]!.queue).toBe(queue)
    expect(items[0]!.state).toBe('waiting')
    expect(typeof items[0]!.id).toBe('string')
    // TOTAL attempts including the first, passed straight through with no
    // arithmetic anywhere in the chain.
    expect(items[0]!.attempts).toBe(3)
  })

  it('reports total independently of the page size', async () => {
    const queue = queueName('paging')
    for (const seq of [1, 2, 3]) await driver.enqueue(queue, { name: 'ok', payload: { seq } })

    const page = await driver.introspect!.list(queue, 'waiting', { offset: 0, limit: 2 })

    // The discriminating pair: a driver returning items.length as total would
    // give 2 here, and the UI's paging control would think page 1 is the last.
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(3)
  })

  it('pages through every waiting job with no loss and no duplication', async () => {
    const queue = queueName('multi-page')
    const JOB_COUNT = 5
    const LIMIT = 2
    // The set this test checks against is built from what THIS test enqueued,
    // never from anything `list()` reports — a test that validates a page
    // against a total drawn from the same response proves nothing.
    const expectedIds = new Set<string>()
    for (let seq = 0; seq < JOB_COUNT; seq++) {
      const { id } = await driver.enqueue(queue, { name: 'ok', payload: { seq } })
      expectedIds.add(id)
    }

    const pages: string[][] = []
    let total: number | undefined
    let offset = 0
    // Bounded by JOB_COUNT (what was actually enqueued), not by `total` from
    // the driver's own response: a driver that misreports total as 0 must not
    // be able to make this loop exit immediately and pass by never iterating.
    for (let guard = 0; guard < JOB_COUNT + 5; guard++) {
      const page = await driver.introspect!.list(queue, 'waiting', { offset, limit: LIMIT })
      total ??= page.total
      if (page.items.length === 0) break
      pages.push(page.items.map(j => j.id))
      offset += LIMIT
    }

    // 5 jobs at limit 2 spans three pages (2, 2, 1).
    expect(pages.length).toBe(3)

    const allIds = pages.flat()
    // total, independently anchored to the count actually enqueued.
    expect(total).toBe(JOB_COUNT)
    // The union of every page has exactly `total` entries: neither undersized
    // (a job dropped mid-pagination) nor oversized (a job fetched twice).
    expect(allIds.length).toBe(total)
    // No id repeats across pages.
    expect(new Set(allIds).size).toBe(allIds.length)
    // Every enqueued id appears in exactly one page. A single-page check
    // cannot distinguish "fixed" from "silently loses rows starting page 2".
    expect(allIds.slice().sort()).toEqual([...expectedIds].sort())
  })

  it('returns the raw envelope from get, not a decoded payload', async () => {
    const queue = queueName('envelope')
    const { id } = await driver.enqueue(queue, { name: 'ok', payload: { hello: 'world' } })

    const detail = await driver.introspect!.get(queue, id)

    expect(detail).toBeDefined()
    // The SPI's contract is the raw envelope: `{ v, payload }` with payload a
    // devalue STRING. A driver decoding here would put the decode path — and
    // its deliberately content-free error message — in three places.
    expect(detail!.envelope).toMatchObject({ v: 1 })
    expect(typeof (detail!.envelope as { payload: unknown }).payload).toBe('string')
    // And the decoded form must NOT have leaked through.
    expect(detail!.envelope).not.toMatchObject({ hello: 'world' })
  })

  it('returns undefined from get for an unknown id', async () => {
    const queue = queueName('missing')
    expect(await driver.introspect!.get(queue, 'no-such-job')).toBeUndefined()
  })

  it('moves a permanently failed job into failed, then back to runnable on retry', async () => {
    const queue = queueName('retry')
    let runs = 0
    driver.registerHandler(queue, 'bad', () => { runs++; throw new Error('boom') })
    consumer = driver.consume(queue, { concurrency: 1 })

    const { id } = await driver.enqueue(queue, { name: 'bad', payload: { a: 1 }, attempts: 1 })
    await until(async () => (await driver.introspect!.counts(queue)).failed === 1)

    const failed = await driver.introspect!.list(queue, 'failed', { offset: 0, limit: 10 })
    expect(failed.items).toHaveLength(1)
    expect(failed.items[0]!.failedReason).toContain('boom')
    expect(runs).toBe(1)

    await driver.introspect!.retry(queue, id)
    await until(async () => runs >= 2)

    // Both halves. "It ran again" alone would pass on a retry that enqueues a
    // DUPLICATE while leaving the original in `failed` — so the failed count
    // must have been consumed too, at least transiently. Re-reading after the
    // second failure would be racy, so the assertion is on the run count plus
    // the absence of a second copy.
    expect(runs).toBe(2)
    const afterRetry = await driver.introspect!.list(queue, 'failed', { offset: 0, limit: 10 })
    expect(afterRetry.items.filter(j => j.id === id)).toHaveLength(1)
  })

  it('rejects a retry for a job that does not exist', async () => {
    const queue = queueName('retry-missing')
    // Must throw, not resolve silently: the API layer turns this into a 409 the
    // UI shows. A silent no-op would render as a successful retry that never ran.
    await expect(driver.introspect!.retry(queue, 'no-such-job')).rejects.toThrow()
  })
})
