import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CONCIERGE_SCHEDULE_PREFIX,
  CRON_DEFAULT_TZ,
  nextFireTime,
  planReconciliation,
  resolveCron,
  schedulerIdFor,
  validateCronPayloads,
} from '../../src/runtime/server/cron'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'

describe('resolveCron', () => {
  it('accepts the string shorthand and defaults the timezone to UTC', () => {
    // NOT system-local. A laptop and a container disagree, and that
    // disagreement surfaces as "the nightly job ran at the wrong hour in
    // production only".
    expect(resolveCron('0 9 * * *')).toEqual({ expression: '0 9 * * *', tz: 'UTC' })
    expect(CRON_DEFAULT_TZ).toBe('UTC')
  })

  it('accepts the object form and keeps an explicit timezone and payload', () => {
    expect(resolveCron({ expression: '0 9 * * MON', tz: 'America/Toronto', payload: { s: 'w' } }))
      .toEqual({ expression: '0 9 * * MON', tz: 'America/Toronto', payload: { s: 'w' } })
  })

  it('rejects an unparseable expression at resolution time', () => {
    expect(() => resolveCron('not a cron')).toThrow(/not a valid cron expression/)
  })

  it('rejects an unknown timezone', () => {
    expect(() => resolveCron({ expression: '0 9 * * *', tz: 'Mars/Olympus' })).toThrow(/timezone/)
  })
})

describe('nextFireTime', () => {
  it('honours the timezone across a DST transition', () => {
    // Spring-forward in America/Toronto 2027 is Sunday 14 March. A 9am local
    // job stays at 9am local, which means the UTC INSTANT moves by an hour:
    // 14:00Z before, 13:00Z after. These exact values were computed against
    // the installed cron-parser 4.9.0, not derived by hand.
    //
    // This case is what catches tz being dropped or ignored: the UTC control
    // below does not move, so an implementation that silently parses
    // everything as UTC produces 09:00Z here and fails.
    const start = new Date('2027-03-12T20:00:00Z').getTime()
    const first = nextFireTime('0 9 * * *', 'America/Toronto', start)
    expect(new Date(first).toISOString()).toBe('2027-03-13T14:00:00.000Z')

    const second = nextFireTime('0 9 * * *', 'America/Toronto', first)
    expect(new Date(second).toISOString()).toBe('2027-03-14T13:00:00.000Z')
  })

  it('does not move for a UTC schedule across the same window', () => {
    const start = new Date('2027-03-12T20:00:00Z').getTime()
    const first = nextFireTime('0 9 * * *', 'UTC', start)
    expect(new Date(first).toISOString()).toBe('2027-03-13T09:00:00.000Z')
    expect(new Date(nextFireTime('0 9 * * *', 'UTC', first)).toISOString())
      .toBe('2027-03-14T09:00:00.000Z')
  })

  it('returns a time strictly after the reference', () => {
    const at = new Date('2027-01-01T09:00:00Z').getTime()
    expect(nextFireTime('0 9 * * *', 'UTC', at)).toBeGreaterThan(at)
  })
})

describe('schedulerIdFor', () => {
  it('namespaces the id so foreign schedulers are identifiable', () => {
    expect(schedulerIdFor('digest')).toBe(`${CONCIERGE_SCHEDULE_PREFIX}digest`)
  })
})

const summary = (id: string) => ({
  id, jobName: 'x', queue: 'default', expression: '0 * * * *', tz: 'UTC',
})

describe('planReconciliation', () => {
  it('upserts every declared schedule', () => {
    const declared = [{ id: schedulerIdFor('a'), jobName: 'a', expression: '0 * * * *', tz: 'UTC' }]
    const plan = planReconciliation({ declared, existing: [] })
    expect(plan.upserts).toEqual(declared)
    expect(plan.removals).toEqual([])
  })

  it('removes an existing schedule that is no longer declared', () => {
    const plan = planReconciliation({
      declared: [],
      existing: [summary(schedulerIdFor('gone'))],
    })
    expect(plan.removals).toEqual([schedulerIdFor('gone')])
  })

  it('leaves a declared schedule in the removal list alone', () => {
    const declared = [{ id: schedulerIdFor('keep'), jobName: 'keep', expression: '0 * * * *', tz: 'UTC' }]
    const plan = planReconciliation({ declared, existing: [summary(schedulerIdFor('keep'))] })
    // Both halves. "Nothing removed" alone is satisfied by an implementation
    // that never removes anything at all.
    expect(plan.removals).toEqual([])
    expect(plan.upserts).toEqual(declared)
  })

  it('never removes a scheduler it does not own', () => {
    // Someone else's repeatable job on a shared queue. Pruning it would make
    // adopting this module destructive to unrelated BullMQ usage.
    const plan = planReconciliation({
      declared: [],
      existing: [summary('someone-elses-scheduler'), summary(schedulerIdFor('ours'))],
    })
    expect(plan.removals).toEqual([schedulerIdFor('ours')])
  })

  it('re-upserts a declared schedule whose expression changed', () => {
    const declared = [{ id: schedulerIdFor('a'), jobName: 'a', expression: '*/5 * * * *', tz: 'UTC' }]
    const plan = planReconciliation({
      declared,
      existing: [{ ...summary(schedulerIdFor('a')), expression: '0 * * * *' }],
    })
    // Upsert is idempotent and updates in place, so a changed expression needs
    // no removal — asserting the absence is what stops a future "clean first"
    // implementation from opening a window where the schedule does not exist.
    expect(plan.upserts).toEqual(declared)
    expect(plan.removals).toEqual([])
  })

  it('removes everything owned when the declared set is empty', () => {
    // This is `cron.enabled: false`: reconciliation runs with an empty
    // declared set rather than being skipped, so "off" means off in Redis.
    const plan = planReconciliation({
      declared: [],
      existing: [summary(schedulerIdFor('a')), summary(schedulerIdFor('b'))],
    })
    expect(plan.upserts).toEqual([])
    expect(plan.removals.sort()).toEqual([schedulerIdFor('a'), schedulerIdFor('b')].sort())
  })
})

describe('validateCronPayloads', () => {
  it('accepts a static payload that satisfies the job schema', async () => {
    const job = defineJob({
      input: z.object({ scope: z.string() }),
      cron: { expression: '0 9 * * *', payload: { scope: 'weekly' } },
      handler: async () => {},
    })
    await expect(validateCronPayloads([job])).resolves.toBeUndefined()
  })

  it('throws at boot when the static payload violates the schema', async () => {
    // Without this, spec 3's consumer-side validation classifies the failure
    // as PERMANENT, so the job dead-letters on every tick forever and nothing
    // about the symptom points at the schedule.
    const job = defineJob({
      name: 'digest',
      input: z.object({ scope: z.string() }),
      cron: { expression: '0 9 * * *', payload: { scope: 42 } },
      handler: async () => {},
    })
    await expect(validateCronPayloads([job])).rejects.toThrow(/digest/)
  })

  it('throws when a schema-bearing cron job supplies no payload at all', async () => {
    const job = defineJob({
      name: 'digest',
      input: z.object({ scope: z.string() }),
      cron: '0 9 * * *',
      handler: async () => {},
    })
    await expect(validateCronPayloads([job])).rejects.toThrow(/digest/)
  })

  it('ignores a cron job with no schema', async () => {
    const job = defineJob({ cron: '0 9 * * *', handler: async () => {} })
    await expect(validateCronPayloads([job])).resolves.toBeUndefined()
  })

  it('ignores a schema-bearing job with no cron', async () => {
    // The ordinary case: payloads come from enqueue callers and are validated
    // there. Asserting it explicitly stops an implementation that validates
    // every job's schema against `undefined` at boot.
    const job = defineJob({ input: z.object({ scope: z.string() }), handler: async () => {} })
    await expect(validateCronPayloads([job])).resolves.toBeUndefined()
  })
})
