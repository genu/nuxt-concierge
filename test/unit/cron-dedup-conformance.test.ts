import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSyncDriver } from '../../src/runtime/server/drivers/sync'
import { createMemoryDriver } from '../../src/runtime/server/drivers/memory'
import { createBullmqDriver } from '../../src/runtime/server/drivers/bullmq'
import { schedulerIdFor } from '../../src/runtime/server/cron'
import { decodePayload } from '../../src/runtime/server/envelope'
import type { ConciergeDriver } from '../../src/runtime/server/drivers/types'

/**
 * `sync`'s contract is ABSENCE, which is a stronger and different claim than
 * "calling it fails". A uniform interface whose sync implementation silently
 * no-ops would make "this driver cannot schedule" indistinguishable from
 * "there are no schedules", and the Schedules panel would render a confident
 * empty table that is a lie. Asserting the type-level fact at runtime means a
 * later "helpful" stub breaks this test rather than quietly changing what the
 * dashboard claims.
 */
describe('sync driver scheduling', () => {
  it('declares no scheduling at all', () => {
    expect(createSyncDriver().schedule).toBeUndefined()
  })
})

describe('enqueue result shape', () => {
  it('reports deduplicated:false when no dedup was requested — sync', async () => {
    const driver = createSyncDriver()
    driver.registerHandler('default', 'noop', async () => {})
    const result = await driver.enqueue('default', { name: 'noop', payload: {} })
    expect(result.deduplicated).toBe(false)
    expect(result.id).toEqual(expect.any(String))
  })

  it('reports deduplicated:false when no dedup was requested — memory', async () => {
    const driver = createMemoryDriver()
    const result = await driver.enqueue('default', { name: 'noop', payload: {} })
    expect(result.deduplicated).toBe(false)
    expect(result.id).toEqual(expect.any(String))
  })
})

const REDIS_URL = process.env.REDIS_URL

/**
 * Polls a predicate until it is true or `timeoutMs` elapses, throwing a
 * descriptive error on timeout rather than letting the test hang or fail with
 * a bare assertion mismatch. Used everywhere a case depends on a real
 * consumer or a real driver having caught up — readiness must be OBSERVED,
 * never guessed with a fixed sleep, which is exactly how an earlier task in
 * this plan shipped a test with ~30ms of slack that failed on jitter with
 * correct code.
 */
const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * ONE table over both drivers, never two files. `depth()` drifted in phase 1
 * precisely because its two implementations were tested separately, and the
 * dedup semantics here are subtler than depth's: the lock/throttle difference
 * is one `PTTL` branch in BullMQ's Lua, and `memory` reimplements it by hand.
 */
const DRIVERS: Array<{ name: string, create: () => ConciergeDriver, skip: boolean }> = [
  { name: 'memory', create: () => createMemoryDriver(), skip: false },
  {
    name: 'bullmq',
    create: () => createBullmqDriver({ connection: { url: REDIS_URL } }),
    // Guarded, not silently degraded: without REDIS_URL this table would run
    // memory-only while still reporting green, which is exactly the shape of
    // "a test that exists, passes and proves nothing".
    skip: !REDIS_URL,
  },
]

for (const { name, create, skip } of DRIVERS) {
  describe.skipIf(skip)(`${name} driver — cron conformance`, () => {
    let driver: ConciergeDriver
    const queue = `conformance-cron-${name}`

    afterEach(async () => { await driver?.close(true) })

    it('upsert is idempotent', async () => {
      driver = create()
      await driver.init()
      const spec = { id: schedulerIdFor('a'), jobName: 'a', expression: '0 * * * *', tz: 'UTC' }
      await driver.schedule!.upsert(queue, spec)
      await driver.schedule!.upsert(queue, spec)

      const listed = (await driver.schedule!.list(queue))
        .filter(s => s.id === schedulerIdFor('a'))
      expect(listed).toHaveLength(1)
      await driver.schedule!.remove(queue, schedulerIdFor('a'))
    })

    it('upsert updates in place when the expression changes', async () => {
      driver = create()
      await driver.init()
      const base = { id: schedulerIdFor('b'), jobName: 'b', tz: 'UTC' }
      await driver.schedule!.upsert(queue, { ...base, expression: '0 * * * *' })
      await driver.schedule!.upsert(queue, { ...base, expression: '*/5 * * * *' })

      const listed = (await driver.schedule!.list(queue)).filter(s => s.id === schedulerIdFor('b'))
      // Both halves — one row AND the new expression. Either alone is
      // satisfied by an implementation that drops the second upsert.
      expect(listed).toHaveLength(1)
      expect(listed[0]!.expression).toBe('*/5 * * * *')
      await driver.schedule!.remove(queue, schedulerIdFor('b'))
    })

    it('remove deletes exactly the named schedule', async () => {
      driver = create()
      await driver.init()
      await driver.schedule!.upsert(queue, { id: schedulerIdFor('c'), jobName: 'c', expression: '0 * * * *', tz: 'UTC' })
      await driver.schedule!.upsert(queue, { id: schedulerIdFor('d'), jobName: 'd', expression: '0 * * * *', tz: 'UTC' })
      await driver.schedule!.remove(queue, schedulerIdFor('c'))

      const ids = (await driver.schedule!.list(queue)).map(s => s.id)
      expect(ids).not.toContain(schedulerIdFor('c'))
      // The second half: a `remove` that cleared everything would pass the
      // assertion above on its own.
      expect(ids).toContain(schedulerIdFor('d'))
      await driver.schedule!.remove(queue, schedulerIdFor('d'))
    })

    it('scopes schedules to their queue', async () => {
      driver = create()
      await driver.init()
      await driver.schedule!.upsert(`${queue}-a`, { id: schedulerIdFor('e'), jobName: 'e', expression: '0 * * * *', tz: 'UTC' })
      expect((await driver.schedule!.list(`${queue}-b`)).map(s => s.id)).not.toContain(schedulerIdFor('e'))
      await driver.schedule!.remove(`${queue}-a`, schedulerIdFor('e'))
    })

    it('a real scheduler tick produces a job a registered handler actually matches', async () => {
      // This is the v1 cron defect verbatim: a scheduler that produces jobs
      // under its OWN id rather than the concierge job name yields jobs no
      // handler matches, failing every tick, permanently, forever. The type
      // wiring for this (schedule.upsert passing `spec.jobName` as the job
      // name — see bullmq.ts and memory.ts's `arm`) is correct today, but
      // nothing before this test exercised the full path: real scheduler,
      // real consumer, real handler lookup by name.
      //
      // Deviation from the brief: the brief's suggested expression,
      // `* * * * *`, has a one-MINUTE floor, which would make this test slow
      // enough to want its documented fallback (asserting the job's name via
      // introspect instead of waiting for a handler match). `nextFireTime`
      // and both drivers' own repeat strategy are documented (cron.ts,
      // bullmq.ts) to route through the exact same `cron-parser` library and
      // version, and that library accepts an optional LEADING seconds field —
      // verified directly against the installed 4.9.0 and against
      // bullmq/dist/esm/classes/job-scheduler.js, which passes the pattern to
      // `parseExpression` unmodified. A seconds-granularity pattern lets this
      // stay the full real-handler-match assertion, on both backends, in a
      // few seconds instead of up to sixty.
      driver = create()
      await driver.init()
      const jobName = `tick-${Date.now()}`
      const id = schedulerIdFor(jobName)
      let matched: { name: string, cron?: { expression: string } } | undefined

      driver.registerHandler(queue, jobName, async (ctx) => {
        matched = { name: ctx.name, cron: ctx.cron }
      })
      const consumer = driver.consume(queue, { concurrency: 1 })

      await driver.schedule!.upsert(queue, { id, jobName, expression: '*/2 * * * * *', tz: 'UTC' })

      const deadline = Date.now() + 8_000
      while (!matched && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100))
      }

      // Would fail outright (matched stays undefined, deadline trips) if the
      // scheduler produced jobs under the scheduler id instead of the job
      // name — no handler would ever be looked up successfully.
      expect(matched?.name).toBe(jobName)
      // The second half of "a real tick": the job the handler received
      // actually carries cron metadata, not just a name that happens to
      // match by coincidence of some unrelated enqueue.
      expect(matched?.cron?.expression).toBe('*/2 * * * * *')

      await driver.schedule!.remove(queue, id)
      await consumer.close(true)
    }, 15_000)

    it('re-upserting a schedule with a changed tz and payload lands in place and preserves iterationCount', async () => {
      // The brief's "upsert updates in place when the expression changes"
      // case only touches `expression`. `tz` and `payload` are resolved and
      // stored independently in both drivers (see ScheduleSpec and both
      // drivers' `upsert`), so an implementation could update one field and
      // drop the others without that case noticing. `iterationCount` is the
      // other half: both drivers document updating a schedule IN PLACE
      // specifically so a re-upsert does not reset it (memory.ts: "a
      // remove-then-add... would reset iterationCount on every boot of every
      // instance").
      driver = create()
      await driver.init()
      const jobName = `retz-${Date.now()}`
      const id = schedulerIdFor(jobName)
      const seen: number[] = []

      driver.registerHandler(queue, jobName, async (ctx) => {
        seen.push((ctx.payload as { n: number }).n)
      })
      driver.consume(queue, { concurrency: 1 })

      // Seconds-granularity for the same reason as the tick-match case above.
      const expression = '*/2 * * * * *'
      await driver.schedule!.upsert(queue, { id, jobName, expression, tz: 'UTC', payload: { n: 1 } })

      const waitUntil = async (predicate: () => boolean, label: string, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs
        while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
        if (!predicate()) throw new Error(`timed out waiting for ${label}`)
      }

      await waitUntil(() => seen.includes(1), 'the first tick to fire with the original payload')

      const before = (await driver.schedule!.list(queue)).find(s => s.id === id)
      const iterationBefore = before?.iterationCount ?? 0
      // Sanity on the fixture itself: if this is 0 the "preserved" assertion
      // below would trivially pass regardless of whether the driver actually
      // preserves anything.
      expect(iterationBefore).toBeGreaterThan(0)

      await driver.schedule!.upsert(queue, { id, jobName, expression, tz: 'America/New_York', payload: { n: 2 } })

      const listed = (await driver.schedule!.list(queue)).filter(s => s.id === id)
      // One row, not two — a re-upsert that failed to match the existing
      // entry (e.g. by id) would have inserted a second.
      expect(listed).toHaveLength(1)
      expect(listed[0]!.tz).toBe('America/New_York')
      // Not reset to zero. A remove-then-add re-implementation would fail
      // this specifically, while still passing every assertion above.
      expect(listed[0]!.iterationCount ?? 0).toBeGreaterThanOrEqual(iterationBefore)

      await waitUntil(() => seen.includes(2), 'a post-upsert tick to fire with the new payload')

      await driver.schedule!.remove(queue, id)
    }, 20_000)

    it.skipIf(name !== 'memory')(
      'a timer that fires late does not replay every missed tick — bounds waiting jobs after a stall',
      async () => {
        // Regression for the missed-tick backfill defect fixed in `arm()`
        // (drivers/memory.ts): it used to advance `next` from the PREVIOUS
        // scheduled tick rather than from `Date.now()`, so once the process
        // timer fires late — a suspended laptop, a blocked event loop, an NTP
        // jump — `next` is already in the past, `delay` computes to 0, and the
        // re-armed timer fires again immediately, replaying every missed
        // window in a chained `setTimeout(…, 0)` loop. The reviewer's repro:
        // `* * * * *` with the clock advanced 10m30s before the pending timer
        // is allowed to run produced 11 waiting jobs pre-fix; the fix bounds
        // it to 1. The README promises "at most one catch-up run, never a
        // backfill" and the spec required a conformance case for this that no
        // task in the plan was ever assigned.
        //
        // Fake timers only make sense here for `memory` — its scheduler is a
        // chain of real Node `setTimeout`s, so jumping the fake clock forward
        // in one step genuinely simulates a stalled timer. `bullmq`'s
        // equivalent schedule is computed server-side by BullMQ's own repeat
        // strategy against Redis; faking THIS process's clock does not stall
        // it, and reproducing a genuinely late BullMQ tick would need a real
        // multi-minute wait this table does not attempt. `bullmq` already
        // does not have this bug by inspection — its `job-scheduler.js` sets
        // `now = max(Date.now(), prevMillis)` before computing the next
        // tick — but that is verified by code reading only, not exercised by
        // this case.
        vi.useFakeTimers()
        try {
          const start = new Date('2027-01-01T00:59:59Z')
          vi.setSystemTime(start)

          driver = create()
          await driver.init()
          const jobName = `stall-${Date.now()}`
          const id = schedulerIdFor(jobName)

          // Scheduled first tick is 2027-01-01T01:00:00Z, one second away.
          await driver.schedule!.upsert(queue, { id, jobName, expression: '* * * * *', tz: 'UTC' })

          // The timer fires LATE: jump the clock forward past ten more
          // one-minute windows BEFORE letting the pending timer actually
          // run, rather than advancing tick-by-tick through each scheduled
          // instant — `advanceTimersByTimeAsync` alone would land the fake
          // clock exactly on each timer's own scheduled time, which is
          // indistinguishable from firing on time and would pass even
          // against the pre-fix code. `setSystemTime` first, then a small
          // `advanceTimersByTimeAsync` to let the now-overdue timer actually
          // run, is the same technique this file's sibling
          // (`memory-schedule.test.ts`, "carrying the tick time") uses to
          // tell the scheduled instant apart from the moment the timer fires.
          vi.setSystemTime(new Date(start.getTime() + 1_000 + 10 * 60_000 + 30_000))
          await vi.advanceTimersByTimeAsync(2_000)

          const { waiting } = await driver.introspect!.counts(queue)
          // Bounded, not asserted to exactly 1 — delivery is at-least-once.
          // 2 is tight enough to fail a backfill (11, pre-fix) while
          // tolerating an ordinary one-more-tick race.
          expect(waiting).toBeLessThanOrEqual(2)

          await driver.schedule!.remove(queue, id)
        }
        finally {
          vi.useRealTimers()
        }
      },
    )
  })

  describe.skipIf(skip)(`${name} driver — dedup conformance`, () => {
    let driver: ConciergeDriver
    const queue = `conformance-dedup-${name}`

    afterEach(async () => { await driver?.close(true) })

    it('lock mode suppresses a second enqueue while the first is queued', async () => {
      driver = create()
      await driver.init()
      const id = `lock-${Date.now()}`
      const first = await driver.enqueue(queue, { name: 'j', payload: { n: 1 }, dedup: { id } })
      const second = await driver.enqueue(queue, { name: 'j', payload: { n: 2 }, dedup: { id } })

      expect(second.deduplicated).toBe(true)
      expect(second.id).toBe(first.id)
    })

    it('throttle mode suppresses within the window', async () => {
      driver = create()
      await driver.init()
      const id = `throttle-${Date.now()}`
      await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id, ttl: 60_000 } })
      const second = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id, ttl: 60_000 } })
      expect(second.deduplicated).toBe(true)
    })

    it('a distinct key is not suppressed', async () => {
      // The discriminating negative. Every case above passes for an
      // implementation that suppresses EVERY enqueue.
      driver = create()
      await driver.init()
      const stamp = Date.now()
      const a = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id: `x-${stamp}` } })
      const b = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id: `y-${stamp}` } })
      expect(b.deduplicated).toBe(false)
      expect(b.id).not.toBe(a.id)
    })

    it('no dedup option means no suppression', async () => {
      driver = create()
      await driver.init()
      const a = await driver.enqueue(queue, { name: 'j', payload: {} })
      const b = await driver.enqueue(queue, { name: 'j', payload: {} })
      expect(b.deduplicated).toBe(false)
      expect(b.id).not.toBe(a.id)
    })

    it('round-trips the dedup id onto the job detail', async () => {
      // `deduplicationId` is a first-class JobDetail field precisely so this
      // table can assert it. Nothing else covers it: bullmq's `introspect.get`
      // needs a live Queue, and the unit tests for both drivers are pure
      // mapping tests.
      driver = create()
      await driver.init()
      const id = `detail-${Date.now()}`
      const { id: jobId } = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id } })
      expect((await driver.introspect!.get(queue, jobId))?.deduplicationId).toBe(id)
    })

    it('suppresses one of two CONCURRENT enqueues on the same key', async () => {
      // The deduplication itself is atomic in both drivers, so exactly one job
      // must exist afterwards — that half is a hard guarantee and is what this
      // asserts.
      //
      // The `deduplicated` FLAG is deliberately not asserted here. On `bullmq`
      // the check is a read followed by an add, two round trips, so both racers
      // can read an empty key and the loser reports `deduplicated: false` for
      // an enqueue that was in fact suppressed. That is a known, documented,
      // one-directional reporting limitation (see EnqueueResult.deduplicated),
      // not a difference in what actually got enqueued — and asserting the flag
      // here would make this test fail on bullmq and pass on memory for a
      // reason that has nothing to do with deduplication working.
      driver = create()
      await driver.init()
      const id = `race-${Date.now()}`
      const enqueue = () => driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id } })

      // Counted as a DELTA, not an absolute value. The brief's original
      // `toBe(1)` assumes a pristine queue, which only holds for `memory`
      // (each `it` gets a fresh in-process Map). `bullmq`'s queue is a real,
      // persistent Redis list shared by every `it` in this describe block —
      // this project's own rule against FLUSHALL/obliterate means the waiting
      // jobs every earlier case in this file left behind (lock, throttle,
      // distinct-key, no-dedup, round-trip) are still sitting there, so an
      // absolute `waiting === 1` fails on a real backend even when
      // deduplication is working correctly. The delta preserves the exact
      // same discriminating power — exactly one NEW job for two concurrent
      // enqueues — without depending on run history.
      const before = (await driver.introspect!.counts(queue)).waiting
      const [a, b] = await Promise.all([enqueue(), enqueue()])
      const after = (await driver.introspect!.counts(queue)).waiting

      expect(a.id).toBe(b.id)
      // The second half: two calls, one NEW job. `a.id === b.id` alone would
      // also hold if both calls had failed to enqueue anything at all.
      expect(after - before).toBe(1)
    })

    it('debounce collapses a burst onto one job', async () => {
      driver = create()
      await driver.init()
      const id = `debounce-${Date.now()}`
      const dedup = { id, ttl: 60_000, extend: true, replace: true }
      // A long delay so every enqueue lands while the previous one is still
      // pending — `replace` only supersedes a job that has not started.
      const opts = { name: 'j', dedup, delay: 30_000 }

      // Same delta reasoning as the concurrent-enqueue case above: `delayed`
      // on a real, un-flushed bullmq queue is not 0 going in once this file
      // has run more than once against the same Redis, and asserting the
      // absolute value would fail for a reason unrelated to debounce.
      const before = (await driver.introspect!.counts(queue)).delayed

      await driver.enqueue(queue, { ...opts, payload: { n: 1 } })
      await driver.enqueue(queue, { ...opts, payload: { n: 2 } })
      await driver.enqueue(queue, { ...opts, payload: { n: 3 } })

      const after = (await driver.introspect!.counts(queue)).delayed
      // One NEW job for three enqueues. Under THROTTLE this is also 1, which
      // is why the payload assertion in the memory-only debounce test is the
      // one that discriminates replace from throttle; this table's job is
      // only to confirm the collapse itself on both drivers.
      expect(after - before).toBe(1)
    })

    it('lock mode does NOT release on an intermediate failure', async () => {
      // Retries move a job through moveToDelayed/retryJob, never
      // moveToFinished, so a job with attempts: 3 holds its key across all
      // three. An implementation that releases on every caught error lets a
      // duplicate in mid-retry — and every other case in this table still
      // passes. Verified against
      // bullmq/dist/esm/scripts/moveToFinished-14.js:606-621.
      driver = create()
      await driver.init()
      const id = `midretry-${Date.now()}`
      driver.registerHandler(queue, 'j', async () => { throw new Error('boom') })
      driver.consume(queue, { concurrency: 1 })

      await driver.enqueue(queue, {
        name: 'j', payload: {}, dedup: { id }, attempts: 3,
        backoff: { type: 'fixed', delay: 30_000 },
      })
      await new Promise(r => setTimeout(r, 500))

      const dup = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id } })
      expect(dup.deduplicated).toBe(true)
    })

    it('debounce leaves the LAST payload, not the first', async () => {
      // What `replace: true` MEANS, verified against a live Queue. The
      // "debounce collapses a burst onto one job" case above deliberately
      // asserts only the job-COUNT delta, because that number is identical
      // under throttle — a survivor carrying the FIRST payload would also
      // produce one job for three enqueues. Payload identity is the only
      // thing that tells replace apart from throttle, and until now the only
      // place asserting it was the memory-only unit test: if BullMQ's
      // `deduplication.replace` quietly behaved like throttle under the
      // hood, every existing assertion in this entire suite would still be
      // green. That is the `attempts: 0` incident in a new location.
      driver = create()
      await driver.init()
      const id = `survivor-${Date.now()}`
      const dedup = { id, ttl: 60_000, extend: true, replace: true }
      // Long delay so every enqueue lands while the previous one is still
      // pending — `replace` only supersedes a job that has not started.
      const opts = { name: 'j', dedup, delay: 30_000 }

      await driver.enqueue(queue, { ...opts, payload: { n: 1 } })
      await driver.enqueue(queue, { ...opts, payload: { n: 2 } })
      const last = await driver.enqueue(queue, { ...opts, payload: { n: 3 } })

      const detail = await driver.introspect!.get(queue, last.id)
      expect(decodePayload(detail!.envelope)).toEqual({ n: 3 })
    })

    it('lock mode holds the key while active and releases it on completion', async () => {
      // The table above only exercises release on an INTERMEDIATE failure
      // (does NOT release). Nothing before this exercised the opposite,
      // successful path against a live Queue: hold while genuinely in
      // flight, then release on finalize. Both halves are asserted, because
      // "released after" alone would also pass a driver that never holds the
      // key in the first place.
      driver = create()
      await driver.init()
      const id = `release-complete-${Date.now()}`
      let started = false
      driver.registerHandler(queue, 'j', async () => {
        started = true
        // Real, short duration so there is a genuine window in which the job
        // is active (not yet finished) to enqueue a duplicate against.
        await new Promise(r => setTimeout(r, 500))
      })
      driver.consume(queue, { concurrency: 1 })

      const first = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id } })

      // Observed readiness, not a guessed sleep: wait for the handler to
      // actually have started before asserting the key is held.
      await waitFor(() => started, 'the job to actually start running')

      const whileActive = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id } })
      expect(whileActive.deduplicated).toBe(true)
      expect(whileActive.id).toBe(first.id)

      await waitFor(
        async () => (await driver.introspect!.get(queue, first.id))?.state === 'completed',
        'the job to complete',
      )

      // Released on completion: this enqueue creates a genuinely NEW job,
      // not the id the just-finished job held.
      const afterComplete = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id } })
      expect(afterComplete.deduplicated).toBe(false)
      expect(afterComplete.id).not.toBe(first.id)
    }, 10_000)

    it('lock mode releases the key on terminal failure', async () => {
      // The mirror image of "does NOT release on an intermediate failure":
      // a job with `attempts: 1` fails PERMANENTLY on its first and only
      // attempt (moveToFinished, not moveToDelayed), and that path must
      // release the key — verified here against a live Queue, not just
      // memory's hand-rolled Lua reimplementation.
      driver = create()
      await driver.init()
      const id = `release-fail-${Date.now()}`
      driver.registerHandler(queue, 'j', async () => { throw new Error('boom') })
      driver.consume(queue, { concurrency: 1 })

      const first = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id }, attempts: 1 })

      await waitFor(
        async () => (await driver.introspect!.get(queue, first.id))?.state === 'failed',
        'the job to fail terminally',
      )

      const after = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id } })
      // Would fail (report deduplicated: true, same id) if the key were held
      // past a terminal failure the way it correctly is past an
      // intermediate one.
      expect(after.deduplicated).toBe(false)
      expect(after.id).not.toBe(first.id)
    }, 10_000)

    it('throttle mode releases once the ttl genuinely expires', async () => {
      // The existing throttle case proves suppression STARTS; nothing waits
      // out a real TTL against a live Queue to prove it ENDS. Both halves are
      // asserted: suppressed inside the window, and — the discriminating
      // half — NOT suppressed once the window has genuinely closed. "Not
      // suppressed after" alone would also pass a driver that never
      // suppresses anything.
      driver = create()
      await driver.init()
      const id = `throttle-expiry-${Date.now()}`
      const ttl = 1_500
      const first = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id, ttl } })

      const within = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id, ttl } })
      expect(within.deduplicated).toBe(true)
      expect(within.id).toBe(first.id)

      // Generous, stated margin: 3x the ttl, not ttl-plus-a-few-ms. An
      // earlier task in this plan shipped a timing case with ~30ms of slack
      // that failed on jitter with otherwise-correct code — real Redis
      // round trips make that risk worse here, not better.
      await new Promise(r => setTimeout(r, ttl * 3))

      const after = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id, ttl } })
      expect(after.deduplicated).toBe(false)
      expect(after.id).not.toBe(first.id)
    }, 10_000)

    it('scopes dedup keys to their queue', async () => {
      // Mirrors "scopes schedules to their queue" above. The same id on two
      // queues must not suppress each other — both drivers document keying
      // dedup by `<queue>::<id>` (memory.ts's `dedupKey`) or BullMQ's own
      // per-queue `de:` prefix, but nothing before this asserted it at
      // runtime for either.
      //
      // NOT asserted via `b.id !== a.id`: BullMQ job ids are a PER-QUEUE
      // sequential counter, so two freshly-touched queues legitimately hand
      // out the same first id — this failed on the very first real-Redis run
      // for exactly that reason, with scoping working correctly the whole
      // time. Counted as deltas on EACH queue instead, matching the delta
      // discipline used elsewhere in this table for the same underlying
      // reason (a real, never-flushed Redis backend).
      driver = create()
      await driver.init()
      const id = `scope-${Date.now()}`
      const queueA = `${queue}-a`
      const queueB = `${queue}-b`
      const beforeA = (await driver.introspect!.counts(queueA)).waiting
      const beforeB = (await driver.introspect!.counts(queueB)).waiting

      const a = await driver.enqueue(queueA, { name: 'j', payload: {}, dedup: { id } })
      const b = await driver.enqueue(queueB, { name: 'j', payload: {}, dedup: { id } })

      const afterA = (await driver.introspect!.counts(queueA)).waiting
      const afterB = (await driver.introspect!.counts(queueB)).waiting

      expect(a.deduplicated).toBe(false)
      expect(b.deduplicated).toBe(false)
      // Both queues gained exactly one NEW job of their own. A scoping bug
      // that let the second enqueue read across into the first queue's key
      // would suppress `b` (caught above) and leave queue B's count
      // unchanged — this is the half that confirms queue A wasn't affected
      // either.
      expect(afterA - beforeA).toBe(1)
      expect(afterB - beforeB).toBe(1)
    })
  })
}
