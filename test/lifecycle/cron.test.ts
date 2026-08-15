import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { startApp, stopApp, flushRedis, killAllSpawned } from './harness'

/**
 * Bullmq-only, gated on REDIS_URL: `startApp` always boots the bullmq
 * driver (see harness.ts), and role: 'worker' — one of these scenarios spawns
 * TWO worker processes against one Redis — is itself refused by the memory
 * driver's guardrail (it cannot run any role but 'both'). There is no
 * memory-only variant of this suite.
 *
 * Every scenario shares one Redis instance and one queue name ("default",
 * from playground/nuxt.config.ts). Without a flush, one scenario's schedulers
 * (concierge-owned or injected-orphan) would bleed into the next scenario's
 * listSchedulers() assertions — same reasoning as retry.test.ts and
 * shutdown.test.ts's own beforeEach.
 */
describe.runIf(process.env.REDIS_URL)('cron across two workers', () => {
  beforeEach(async () => {
    await flushRedis()
  })

  // Belt-and-braces beyond each test's own try/finally, matching the rest of
  // this suite.
  afterAll(() => {
    killAllSpawned()
  })

  /**
   * The case that would justify leader election if it failed. Two worker
   * processes boot concurrently against one Redis; both reconcile with no
   * coordination. If BullMQ's one-delayed-job-per-scheduler guarantee did not
   * hold, this produces two schedulers and two runs per tick.
   *
   * Real cron granularity (the fixture is `* * * * *`), so this genuinely
   * waits on up to two real minute boundaries — the generous timeout below
   * is wall-clock budget, not padding.
   */
  it('produces exactly one scheduler and bounded runs per tick', async () => {
    const a = await startApp({ role: 'worker' })
    const b = await startApp({ role: 'worker' })

    try {
      const schedulers = await a.listSchedulers('default')
      expect(schedulers.filter(s => s.jobName === 'heartbeat-digest')).toHaveLength(1)

      const runs = await a.countRunsOverTicks('heartbeat-digest', 2)
      // Counted and BOUNDED, never asserted to be exactly N. Delivery is
      // at-least-once, so a redelivery is legal — but asserting nothing would
      // let a driver that fires on every instance pass.
      expect(runs).toBeGreaterThanOrEqual(2)
      expect(runs).toBeLessThanOrEqual(3)
    }
    finally {
      await stopApp(a)
      await stopApp(b)
    }
  }, 220_000)

  it('prunes a schedule that is no longer declared', async () => {
    const app = await startApp({ role: 'worker' })
    try {
      await app.injectOrphanScheduler('default', 'concierge:deleted-job')
      await app.restart()
      const ids = (await app.listSchedulers('default')).map(s => s.id)
      expect(ids).not.toContain('concierge:deleted-job')
      // The second half: a prune that removed everything would pass above.
      expect(ids).toContain('concierge:heartbeat-digest')
    }
    finally {
      await stopApp(app)
    }
  }, 60_000)

  it('leaves a foreign scheduler on the same queue untouched', async () => {
    // Adopting concierge on a queue that already carries unrelated BullMQ
    // repeatable jobs must not delete them. Covered as a unit in
    // planReconciliation, but asserted end-to-end because the ownership filter
    // is the only thing standing between a first boot and someone else's
    // schedules.
    const app = await startApp({ role: 'worker' })
    try {
      await app.injectOrphanScheduler('default', 'someone-elses-scheduler')
      await app.restart()
      expect((await app.listSchedulers('default')).map(s => s.id))
        .toContain('someone-elses-scheduler')
    }
    finally {
      await stopApp(app)
    }
  }, 60_000)

  it('reports the same tick across a retry of that tick', async () => {
    // ctx.cron.tick is the SCHEDULED time, and its stability across a retry is
    // the entire reason it is offered as an idempotency key. A handler that
    // saw Date.now() would get a different value on every attempt, which is
    // precisely the thing that makes an idempotency key useless — and no unit
    // test can observe it, because the retry has to be real.
    const app = await startApp({ role: 'worker', failFirstAttempt: 'heartbeat-digest' })
    try {
      const ticks = await app.collectTicks('heartbeat-digest', { attempts: 2 })
      expect(ticks).toHaveLength(2)
      expect(ticks[0]).toBe(ticks[1])
      // Both halves: two equal values also satisfy "the handler never ran and
      // both are undefined".
      expect(ticks[0]).toEqual(expect.any(Number))
    }
    finally {
      await stopApp(app)
    }
  }, 120_000)
})
