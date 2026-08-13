import { appendFileSync } from 'node:fs'
import { defineJob } from '#concierge-handlers'

export interface FailingPayload {
  seq: number
  /** Fail on every attempt at or below this number. `0` never fails. */
  failUntilAttempt: number
}

export default defineJob<FailingPayload>({
  queue: 'default',
  attempts: 3,
  // Short and fixed so the scenario does not spend 1s+2s waiting on the
  // default exponential policy.
  backoff: { type: 'fixed', delay: 100 },
  handler: async (ctx) => {
    const { seq, failUntilAttempt } = ctx.payload

    if (process.env.CONCIERGE_TEST_LOG) {
      appendFileSync(
        process.env.CONCIERGE_TEST_LOG,
        `${JSON.stringify({ jobId: seq, attempt: ctx.attempt, pid: process.pid, id: ctx.id })}\n`,
      )
    }

    if (ctx.attempt <= failUntilAttempt) {
      throw new Error(`deliberate failure on attempt ${ctx.attempt}`)
    }
  },
})
