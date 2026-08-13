import { appendFileSync } from 'node:fs'
import { z } from 'zod'
import { defineJob } from '#concierge-handlers'

export default defineJob({
  queue: 'default',
  attempts: 3,
  input: z.object({
    seq: z.number(),
    // Transforms, so the enqueue side is a string and the handler side a
    // number — which is what makes the transform-once property observable end
    // to end rather than only in unit tests. "Once" means APPLIED once: both
    // sides call the schema, and the producer discards its result.
    //
    // Deliberately minimal, and NOT a template to copy. `z.string()` accepts
    // "abc", so Number() yields NaN and the handler sees it — real code wants
    // `.regex(/^\d+$/).transform(Number).pipe(z.number().int())`. Tightening
    // it here would bury the one thing this fixture exists to demonstrate:
    // that the input and output types differ across the queue.
    id: z.string().transform(Number),
  }),
  handler: async (ctx) => {
    if (process.env.CONCIERGE_TEST_LOG) {
      appendFileSync(
        process.env.CONCIERGE_TEST_LOG,
        `${JSON.stringify({
          jobId: ctx.payload.seq,
          attempt: ctx.attempt,
          // Recorded so the test can assert the handler saw a NUMBER.
          idType: typeof ctx.payload.id,
          idValue: ctx.payload.id,
        })}\n`,
      )
    }
  },
})
