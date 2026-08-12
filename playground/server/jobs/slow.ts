import { appendFileSync } from 'node:fs'
import { defineJob } from '#concierge-handlers'

export default defineJob({
  queue: 'default',
  handler: async (ctx) => {
    const { id, attempt, payload } = ctx
    const durationMs = (payload as { durationMs?: number }).durationMs ?? 200
    await new Promise(r => setTimeout(r, durationMs))

    // Append-only so the test can read completions after the process dies.
    appendFileSync(
      process.env.CONCIERGE_TEST_LOG!,
      `${JSON.stringify({ jobId: (payload as { seq: number }).seq, attempt, pid: process.pid, id })}\n`,
    )
  },
})
