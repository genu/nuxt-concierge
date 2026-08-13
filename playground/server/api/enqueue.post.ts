import { defineEventHandler, readBody } from 'h3'
import { useQueue } from '#concierge'

// A test fixture, not shipped code, so this is not a real security boundary
// — just two lines to stop a typo'd/non-numeric `count` from enqueueing an
// unbounded (or infinite-looping, for NaN/Infinity) number of jobs during
// manual playground use.
const MAX_COUNT = 100

export default defineEventHandler(async (event) => {
  // `offset` lets the lifecycle harness enqueue two distinguishable batches
  // (e.g. a short one and a long one) in separate requests without their
  // `seq` numbers colliding — without it, two calls with `count: 5` each
  // both produce seq 0..4, and the log's per-jobId de-duplication would
  // conflate a completion from the first batch with one from the second.
  const { count: rawCount = 1, durationMs = 200, offset = 0 } = await readBody(event)
  const count = Number.isFinite(rawCount) ? Math.min(Math.max(rawCount, 0), MAX_COUNT) : 1
  const { enqueue } = useQueue()

  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const { id } = await enqueue('slow', { seq: offset + i, durationMs })
    ids.push(id)
  }

  return { ids }
})
