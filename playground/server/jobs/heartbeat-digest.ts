import { appendFileSync } from 'node:fs'
import { defineJob } from '#concierge-handlers'

/**
 * The lifecycle suite's only real cron fixture (test/lifecycle/cron.test.ts).
 * Every minute, so a dev session or a lifecycle run actually sees it fire —
 * seconds-granularity would be faster to test but would no longer be the
 * shape a real deploy uses.
 */
export default defineJob({
  cron: '* * * * *',
  handler: async (ctx) => {
    console.log(`[digest] tick ${ctx.cron?.tick} (${ctx.cron?.tz})`)

    // Structured, machine-readable record of this run, appended BEFORE the
    // failure injection below so a run that goes on to throw is still
    // recorded — test/lifecycle/cron.test.ts's "reports the same tick across
    // a retry" scenario needs to see attempt 1's tick even though attempt 1
    // is the one that fails. Same append-only-log convention every other
    // playground job fixture (failing.ts, typed.ts) already uses.
    if (process.env.CONCIERGE_TEST_LOG) {
      appendFileSync(
        process.env.CONCIERGE_TEST_LOG,
        `${JSON.stringify({ name: ctx.name, tick: ctx.cron?.tick, tz: ctx.cron?.tz, attempt: ctx.attempt })}\n`,
      )
    }

    // Lifecycle-only failure injection, gated on BOTH an explicit env var and
    // the job name, so this never fires during ordinary `pnpm dev` use — only
    // test/lifecycle/cron.test.ts's CONCIERGE_FAIL_FIRST_ATTEMPT start option
    // can trigger it. Exists to prove ctx.cron.tick is the SCHEDULED time, not
    // Date.now(): only a real retry can observe that, no unit test can.
    if (process.env.CONCIERGE_FAIL_FIRST_ATTEMPT === ctx.name && ctx.attempt === 1) {
      throw new Error(`[heartbeat-digest] injected failure on attempt 1 (lifecycle test only)`)
    }
  },
})
