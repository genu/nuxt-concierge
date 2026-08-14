import { describe, it, expect } from 'vitest'
import { bullStateToJobState, jobToSummary } from '../../../src/runtime/server/drivers/bullmq'

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
