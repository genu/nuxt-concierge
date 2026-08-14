import { describe, it, expect } from 'vitest'
import { Queue } from 'bullmq'
import { bullStateToJobState, jobToSummary, createBullmqDriver } from '../../../src/runtime/server/drivers/bullmq'

describe('bullStateToJobState', () => {
  it('maps the five canonical states directly', () => {
    expect(bullStateToJobState('wait')).toBe('waiting')
    expect(bullStateToJobState('active')).toBe('active')
    expect(bullStateToJobState('completed')).toBe('completed')
    expect(bullStateToJobState('failed')).toBe('failed')
    expect(bullStateToJobState('delayed')).toBe('delayed')
  })

  it('folds prioritized into waiting, matching depth()', () => {
    // depth() already counts `prioritized` as due work (bullmq.ts's comment on
    // depth explains why). If this mapping disagreed, a job would be counted
    // by the no-worker guardrail but invisible in the dashboard.
    expect(bullStateToJobState('prioritized')).toBe('waiting')
  })

  it('returns undefined for states outside the canonical five', () => {
    // NOT folded into a nearby state: `paused` and `waiting-children` are
    // genuinely not one of the five, and inventing a mapping would make the
    // dashboard claim something false. The caller filters these out.
    expect(bullStateToJobState('paused')).toBeUndefined()
    expect(bullStateToJobState('waiting-children')).toBeUndefined()
    expect(bullStateToJobState('unknown')).toBeUndefined()
  })
})

describe('jobToSummary', () => {
  const job = {
    id: 42,
    name: 'send-email',
    attemptsMade: 2,
    opts: { attempts: 5 },
    timestamp: 1000,
    finishedOn: 5000,
    failedReason: 'smtp down',
  }

  it('stringifies the id, since BullMQ ids are numeric', () => {
    const summary = jobToSummary(job as never, 'mail', 'failed')
    // JobSummary.id is a string across every driver. A numeric id leaking
    // through would make `get(queue, id)` miss on a strict comparison.
    expect(summary.id).toBe('42')
    expect(typeof summary.id).toBe('string')
  })

  it('reports attempts MADE and TOTAL attempts without translating between them', () => {
    const summary = jobToSummary(job as never, 'mail', 'failed')
    expect(summary.attemptsMade).toBe(2)
    expect(summary.attempts).toBe(5)
  })

  it('carries the failure reason and timestamps', () => {
    const summary = jobToSummary(job as never, 'mail', 'failed')
    expect(summary.failedReason).toBe('smtp down')
    expect(summary.createdAt).toBe(1000)
    expect(summary.finishedAt).toBe(5000)
  })

  it('omits finishedAt for a job that has not finished', () => {
    const summary = jobToSummary({ ...job, finishedOn: undefined } as never, 'mail', 'active')
    // Explicitly undefined rather than 0: a 0 would render as the epoch in the
    // UI, which reads as a real timestamp rather than an absent one.
    expect(summary.finishedAt).toBeUndefined()
  })
})

/**
 * Redis-gated: `getJobs` applies its start/end range independently to EACH
 * BullMQ type key it is given (see the comment on `introspect.list` in
 * bullmq.ts), so a naive `offset` passed straight through as the Redis range
 * start silently drops every `prioritized` job once `wait` alone exceeds
 * `offset`. Guarded on `REDIS_URL` exactly like the bullmq half of
 * test/unit/retry-conformance.test.ts, and given a per-run unique queue name
 * for the same reason: a name that repeats byte-for-byte across runs would
 * let an interrupted run's leftover jobs poison the next run's counts.
 */
describe('introspect.list pagination (bullmq, requires REDIS_URL)', () => {
  const REDIS_URL = process.env.REDIS_URL
  const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  it.skipIf(!REDIS_URL)(
    'pages through mixed wait+prioritized jobs with no loss and no duplication',
    async () => {
      const queue = `bullmq-introspect-pagination-${RUN_ID}`
      const driver = createBullmqDriver({ connection: { url: REDIS_URL } })
      // A raw Queue, not the driver, because this module's own `enqueue`
      // never passes `priority` — seeding a `prioritized` job requires
      // reaching past the driver straight into BullMQ.
      const rawQueue = new Queue(queue, { connection: { url: REDIS_URL } })

      await driver.init()

      const WAIT_COUNT = 15
      const PRIORITIZED_COUNT = 10
      const LIMIT = 10
      const expectedIds = new Set<string>()

      try {
        for (let i = 0; i < WAIT_COUNT; i++) {
          const { id } = await driver.enqueue(queue, { name: 'plain', payload: { i } })
          expectedIds.add(id)
        }
        for (let i = 0; i < PRIORITIZED_COUNT; i++) {
          const added = await rawQueue.add('prioritized', { i }, { priority: i + 1 })
          expectedIds.add(String(added.id))
        }

        const pages: string[][] = []
        const first = await driver.introspect!.list(queue, 'waiting', { offset: 0, limit: LIMIT })
        const total = first.total
        pages.push(first.items.map(j => j.id))
        for (let offset = LIMIT; offset < total; offset += LIMIT) {
          const page = await driver.introspect!.list(queue, 'waiting', { offset, limit: LIMIT })
          pages.push(page.items.map(j => j.id))
        }

        // total reports the full 25, matching what count() would compute too.
        expect(total).toBe(WAIT_COUNT + PRIORITIZED_COUNT)

        const allIds = pages.flat()
        // The union of every page has exactly `total` entries: neither
        // undersized (a job dropped, which is exactly what happened when the
        // offset was applied to the Redis range) nor oversized (a job
        // fetched twice).
        expect(allIds.length).toBe(total)
        // No id repeats across pages.
        expect(new Set(allIds).size).toBe(allIds.length)
        // Every seeded id — both `wait` and `prioritized` — appears in
        // exactly one page. A single-page check cannot distinguish "fixed"
        // from "prioritized jobs silently dropped starting page 2".
        expect(allIds.slice().sort()).toEqual([...expectedIds].sort())
      }
      finally {
        await rawQueue.obliterate({ force: true }).catch(() => {})
        await rawQueue.close()
        await driver.close(true)
      }
    },
  )
})
