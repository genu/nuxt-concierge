import { defineEventHandler, readBody } from 'h3'
import { useQueue } from '#concierge'

export default defineEventHandler(async (event) => {
  // `offset` lets the lifecycle harness enqueue two distinguishable batches
  // (e.g. a short one and a long one) in separate requests without their
  // `seq` numbers colliding — without it, two calls with `count: 5` each
  // both produce seq 0..4, and the log's per-jobId de-duplication would
  // conflate a completion from the first batch with one from the second.
  const { count = 1, durationMs = 200, offset = 0 } = await readBody(event)
  const { enqueue } = useQueue()

  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const { id } = await enqueue('slow', { seq: offset + i, durationMs })
    ids.push(id)
  }

  return { ids }
})
