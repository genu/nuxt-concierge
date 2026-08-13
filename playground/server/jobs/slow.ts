import { appendFileSync } from 'node:fs'
import { defineJob } from '#concierge-handlers'

export interface SlowPayload {
  seq: number
  durationMs?: number
}

export default defineJob<SlowPayload>({
  queue: 'default',
  handler: async (ctx) => {
    const { id, attempt, payload } = ctx
    const durationMs = payload.durationMs ?? 200
    await new Promise(r => setTimeout(r, durationMs))

    // Append-only so the test can read completions after the process dies.
    // CONCIERGE_TEST_LOG is a harness-only env var (test/lifecycle/harness.ts)
    // — without this guard, `pnpm dev`/a normal playground run has no value
    // for it, appendFileSync throws on an empty path, and every "slow" job
    // fails outside the lifecycle test harness.
    if (process.env.CONCIERGE_TEST_LOG) {
      appendFileSync(
        process.env.CONCIERGE_TEST_LOG,
        `${JSON.stringify({ jobId: payload.seq, attempt, pid: process.pid, id })}\n`,
      )
    }
  },
})
