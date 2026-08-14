import { describe, expect, it } from 'vitest'
import { cronContextFromJob, schedulerToSummary } from '../../../src/runtime/server/drivers/bullmq'
import { schedulerIdFor } from '../../../src/runtime/server/cron'

describe('schedulerToSummary', () => {
  it('maps a JobSchedulerJson onto the canonical summary', () => {
    const summary = schedulerToSummary({
      key: schedulerIdFor('digest'),
      name: 'digest',
      pattern: '0 9 * * *',
      tz: 'America/Toronto',
      next: 1_800_000_000_000,
      iterationCount: 4,
    }, 'default')

    expect(summary).toEqual({
      id: schedulerIdFor('digest'),
      jobName: 'digest',
      queue: 'default',
      expression: '0 9 * * *',
      tz: 'America/Toronto',
      next: 1_800_000_000_000,
      iterationCount: 4,
    })
  })

  it('defaults an absent tz to UTC rather than leaving it undefined', () => {
    // BullMQ omits `tz` when the schedule was created without one. Leaving it
    // undefined would make the Schedules panel render a blank column for every
    // UTC schedule, which reads as "unknown" rather than "UTC".
    const summary = schedulerToSummary({ key: 'k', name: 'j', pattern: '0 * * * *' }, 'default')
    expect(summary.tz).toBe('UTC')
  })
})

describe('cronContextFromJob', () => {
  it('extracts the tick from prevMillis when present', () => {
    expect(cronContextFromJob({
      id: `repeat:${schedulerIdFor('digest')}:1800000000000`,
      repeatJobKey: schedulerIdFor('digest'),
      opts: { prevMillis: 1_800_000_000_000, repeat: { pattern: '0 9 * * *', tz: 'UTC' } },
    })).toEqual({ tick: 1_800_000_000_000, expression: '0 9 * * *', tz: 'UTC' })
  })

  it('falls back to the tick encoded in the job id', () => {
    // BullMQ's getSchedulerNextJobId builds `repeat:<schedulerId>:<millis>`
    // (job-scheduler.js:220-222), and the id is stable across a retry because
    // the job record is reused. `prevMillis` is documented as internal, so the
    // id is the more durable of the two — both are read, neither is trusted
    // alone.
    expect(cronContextFromJob({
      id: `repeat:${schedulerIdFor('digest')}:1800000000000`,
      repeatJobKey: schedulerIdFor('digest'),
      opts: { repeat: { pattern: '0 9 * * *' } },
    })).toEqual({ tick: 1_800_000_000_000, expression: '0 9 * * *', tz: 'UTC' })
  })

  it('returns undefined for an ordinary enqueued job', () => {
    // Paired with the positive cases deliberately: an implementation that
    // always returns a context would satisfy both of those.
    expect(cronContextFromJob({ id: '42', opts: {} })).toBeUndefined()
  })

  it('returns undefined when the id is unparseable and prevMillis is absent', () => {
    expect(cronContextFromJob({
      id: 'repeat:weird', repeatJobKey: 'x', opts: { repeat: { pattern: '0 * * * *' } },
    })).toBeUndefined()
  })
})
