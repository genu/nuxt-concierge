import { defineEventHandler, readBody } from 'h3'
import { useQueue } from '#concierge'

// A test fixture, not shipped code, so this is not a real security boundary
// — just two lines to stop a typo'd/non-numeric `count` from enqueueing an
// unbounded (or infinite-looping, for NaN/Infinity) number of jobs during
// manual playground use.
const MAX_COUNT = 100

export default defineEventHandler(async (event) => {
  const {
    job = 'slow',
    count: rawCount = 1,
    offset = 0,
    // Kept as its own top-level field (rather than folded into `payload`
    // only) for backward compatibility with the lifecycle harness's own
    // `enqueue(app, count, durationMs, offset)` helper (test/lifecycle/harness.ts),
    // which still posts `durationMs` as a top-level body field. Every
    // currently-passing test/lifecycle/shutdown.test.ts scenario depends on
    // this reaching the `slow` job unchanged.
    durationMs,
    payload = {},
  } = await readBody(event)

  // Truncated as well as clamped: a fractional 0.5 passes the finite and range
  // checks, then the loop still runs once, so `count` would not mean what it says.
  const count = Number.isFinite(rawCount)
    ? Math.min(Math.max(Math.trunc(rawCount), 0), MAX_COUNT)
    : 1
  const { enqueue } = useQueue()

  const ids: string[] = []
  const errors: string[] = []

  for (let i = 0; i < count; i++) {
    try {
      // Cast: this fixture route enqueues a NAME chosen at runtime, which is
      // exactly the case the generated literal union exists to prevent. It is
      // deliberate here and confined to the harness's own entry point — the
      // typed path is asserted in test/types/enqueue.test-d.ts and by the
      // playground's own typed call sites.
      const { id } = await enqueue(
        job as 'slow',
        {
          seq: offset + i,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...payload,
        } as never,
      )
      ids.push(id)
    }
    catch (error) {
      // Surfaced rather than thrown so a producer-side validation rejection
      // is observable to the test as data instead of a 500.
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  return { ids, errors }
})
