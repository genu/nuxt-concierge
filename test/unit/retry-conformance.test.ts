import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { backoffDelay, createMemoryDriver } from '../../src/runtime/server/drivers/memory'
import { createBullmqDriver } from '../../src/runtime/server/drivers/bullmq'
import type { ConciergeDriver, Consumer } from '../../src/runtime/server/drivers/types'

/**
 * One table, run against every driver that claims to retry.
 *
 * Two independent test files is how depth() drifted between the drivers: the
 * contract was undocumented and each file encoded its own author's reading.
 * The `sync` driver is deliberately absent — it executes inline so errors
 * propagate to the enqueue caller, and retrying would swallow exactly what it
 * exists to expose.
 */
const RETRYING_DRIVERS: Array<[string, () => ConciergeDriver]> = [
  ['memory', () => createMemoryDriver()],
  // Only when a real Redis is available. `pnpm test` is deliberately
  // Redis-free; CI supplies REDIS_URL, and `pnpm test:lifecycle` always has
  // it. Skipping silently is acceptable here ONLY because the same table also
  // runs against `memory` unconditionally, so a broken table cannot pass
  // everywhere by being skipped everywhere.
  ...(process.env.REDIS_URL
    ? [['bullmq', () => createBullmqDriver({
        connection: { url: process.env.REDIS_URL },
        bullmq: { maxStalledCount: 3, stalledInterval: 1000 },
      })] as [string, () => ConciergeDriver]]
    : []),
]

/**
 * Folded into every queue name below so two invocations of this suite never
 * share a queue. A name that is merely unique per driver+case (e.g.
 * `retry-conformance-bullmq-bad`) is byte-identical across every run, so an
 * interrupted local run that leaves a waiting/delayed job behind on one of
 * these queues would have the NEXT run's worker pick it up and inflate that
 * run's attempt count. Generated once per process so every case in a single
 * run still shares it (only cross-run collisions are the concern).
 */
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

describe('backoffDelay', () => {
  it('returns the fixed delay unchanged for every retry index', () => {
    expect(backoffDelay({ type: 'fixed', delay: 250 }, 1)).toBe(250)
    expect(backoffDelay({ type: 'fixed', delay: 250 }, 4)).toBe(250)
  })

  it('doubles per retry for exponential, starting at delay', () => {
    // Matches the observed BullMQ gaps from Step 1 (probed against real
    // Redis: ~226/411/824ms for attempts=4, backoff delay=200 — i.e. retry k
    // waits 2 ** (k - 1) * delay, confirming the backoffs.js reading).
    expect(backoffDelay({ type: 'exponential', delay: 1000 }, 1)).toBe(1000)
    expect(backoffDelay({ type: 'exponential', delay: 1000 }, 2)).toBe(2000)
    expect(backoffDelay({ type: 'exponential', delay: 1000 }, 3)).toBe(4000)
  })

  it('returns 0 when no backoff is configured', () => {
    expect(backoffDelay(undefined, 1)).toBe(0)
  })
})

describe.each(RETRYING_DRIVERS)('%s driver retry contract', (name, make) => {
  let driver: ConciergeDriver
  let consumer: Consumer | undefined
  const queueName = (label: string) => `retry-conformance-${RUN_ID}-${name}-${label}`

  beforeEach(async () => {
    driver = make()
    await driver.init()
    consumer = undefined
  })

  afterEach(async () => {
    // Closed here, not at the end of each `it`, so a failed assertion cannot
    // leak a live worker into the rest of the file and add noise to the
    // diagnostics of the run you most want to read cleanly.
    if (consumer) await consumer.close(true)
    await driver.close(true)
  })

  const runUntilSettled = async (attemptsSeen: () => number, expected: number) => {
    const deadline = Date.now() + 5000
    while (attemptsSeen() < expected && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
    }
  }

  it('runs a succeeding job exactly once', async () => {
    const queue = queueName('ok')
    let runs = 0
    driver.registerHandler(queue, 'ok', () => { runs++ })
    consumer = driver.consume(queue, { concurrency: 1 })

    await driver.enqueue(queue, { name: 'ok', payload: {}, attempts: 3 })
    await runUntilSettled(() => runs, 1)
    await new Promise(r => setTimeout(r, 100))

    expect(runs).toBe(1)
  })

  it('retries a failing job up to attempts and then stops', async () => {
    const queue = queueName('bad')
    let runs = 0
    driver.registerHandler(queue, 'bad', () => { runs++; throw new Error('nope') })
    consumer = driver.consume(queue, { concurrency: 1 })

    await driver.enqueue(queue, { name: 'bad', payload: {}, attempts: 3 })
    await runUntilSettled(() => runs, 3)
    await new Promise(r => setTimeout(r, 150))

    // Exactly 3: fewer means attempts was not honoured, more means the
    // ceiling is not enforced. Asserting >= 3 would pass on an infinite loop.
    expect(runs).toBe(3)
  })

  it('succeeds on the second attempt without consuming the third', async () => {
    const queue = queueName('flaky')
    let runs = 0
    driver.registerHandler(queue, 'flaky', () => {
      runs++
      if (runs === 1) throw new Error('first only')
    })
    consumer = driver.consume(queue, { concurrency: 1 })

    await driver.enqueue(queue, { name: 'flaky', payload: {}, attempts: 3 })
    await runUntilSettled(() => runs, 2)
    await new Promise(r => setTimeout(r, 150))

    expect(runs).toBe(2)
  })

  it('never retries when attempts is 1', async () => {
    const queue = queueName('once')
    let runs = 0
    driver.registerHandler(queue, 'once', () => { runs++; throw new Error('nope') })
    consumer = driver.consume(queue, { concurrency: 1 })

    await driver.enqueue(queue, { name: 'once', payload: {}, attempts: 1 })
    await new Promise(r => setTimeout(r, 200))

    expect(runs).toBe(1)
  })

  it('runs a failing job exactly once when attempts is not supplied', async () => {
    const queue = queueName('default-attempts')
    let runs = 0
    driver.registerHandler(queue, 'default-attempts', () => { runs++; throw new Error('nope') })
    consumer = driver.consume(queue, { concurrency: 1 })

    // NO `attempts` — this is the contract: absent means ONE attempt, never a
    // hardcoded ceiling. The memory driver used to default to 3 here while
    // bullmq defaulted to none, which is how a flaky job passed locally and
    // dead-lettered on first failure in production.
    await driver.enqueue(queue, { name: 'default-attempts', payload: {} })
    await new Promise(r => setTimeout(r, 400))

    expect(runs).toBe(1)
  })

  it('stops immediately on a permanent failure, without consuming remaining attempts', async () => {
    const queue = queueName('permanent')
    let runs = 0
    driver.registerHandler(queue, 'permanent', () => {
      runs++
      throw Object.assign(new Error('bad payload'), { retryable: false })
    })
    consumer = driver.consume(queue, { concurrency: 1 })

    await driver.enqueue(queue, { name: 'permanent', payload: {}, attempts: 5 })
    await new Promise(r => setTimeout(r, 250))

    expect(runs).toBe(1)
  })

  it('waits the backoff delay before retrying', async () => {
    const queue = queueName('slow-retry')
    const stamps: number[] = []
    driver.registerHandler(queue, 'slow-retry', () => {
      stamps.push(Date.now())
      throw new Error('nope')
    })
    consumer = driver.consume(queue, { concurrency: 1 })

    await driver.enqueue(queue, {
      name: 'slow-retry',
      payload: {},
      attempts: 2,
      backoff: { type: 'fixed', delay: 300 },
    })
    await runUntilSettled(() => stamps.length, 2)

    expect(stamps).toHaveLength(2)
    // Bounded on both sides. A lower bound alone passes on a driver that
    // waits forever; an upper bound alone passes on one that never waits.
    const gap = stamps[1]! - stamps[0]!
    expect(gap).toBeGreaterThanOrEqual(280)
    expect(gap).toBeLessThan(1200)
  })

  it('doubles the backoff delay per retry for exponential, against the real driver', async () => {
    const queue = queueName('exp-retry')
    const stamps: number[] = []
    driver.registerHandler(queue, 'exp-retry', () => {
      stamps.push(Date.now())
      throw new Error('nope')
    })
    consumer = driver.consume(queue, { concurrency: 1 })

    await driver.enqueue(queue, {
      name: 'exp-retry',
      payload: {},
      attempts: 3,
      backoff: { type: 'exponential', delay: 200 },
    })
    await runUntilSettled(() => stamps.length, 3)

    expect(stamps).toHaveLength(3)
    const gap1 = stamps[1]! - stamps[0]!
    const gap2 = stamps[2]! - stamps[1]!

    // gap1's CEILING is the discriminating assertion in this test. Under the
    // established index (2 ** (k-1)) the first retry waits `delay` ≈ 200ms; a
    // shift to 2 ** k would make it ≈400ms. A ceiling above 400 would let that
    // regression pass — which is the whole reason this case exists, since the
    // index was established by a one-off probe (see backoffDelay's comment)
    // and nothing else re-checks it. A ratio check (gap2 / gap1 ≈ 2) cannot
    // substitute for this: a ±1 index shift preserves the ratio exactly
    // (400/200 and 800/400 are both 2), so only an absolute ceiling on gap1
    // discriminates.
    //
    // 350 sits ~1.55x above the ~226ms this actually measures (Step 1's
    // probe), well clear of scheduling jitter, and well below the 400ms a
    // wrong index would produce.
    expect(gap1).toBeGreaterThanOrEqual(180)
    expect(gap1).toBeLessThan(350)

    expect(gap2).toBeGreaterThanOrEqual(380)
    expect(gap2).toBeLessThan(620)
  })
})
