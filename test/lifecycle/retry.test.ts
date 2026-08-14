import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import {
  spawnApp, waitForReady, readLog, cleanup, flushRedis,
  killAllSpawned, type AppHandle, type LogLine,
} from './harness'

/**
 * The `typed` job's log lines (playground/server/jobs/typed.ts) have a
 * different shape than `LogLine`: `idType`/`idValue` instead of `pid`/`id`.
 * harness.ts's `readLog` types every line as `LogLine` because that is the
 * shape the jobs it was originally written for (`slow`, and this file's own
 * `failing`) share — declared locally here since this shape is specific to
 * one fixture job this file alone reads.
 */
interface TypedLogLine {
  jobId: number
  attempt: number
  idType: string
  idValue: number
}

let app: AppHandle | undefined

// Every bullmq scenario below shares one queue name in one Redis instance.
// Without a flush, one scenario's leftovers could bleed into the next
// scenario's counts. A no-op without REDIS_URL.
beforeEach(async () => {
  await flushRedis()
})

afterEach(() => {
  if (app) cleanup(app)
  app = undefined
})

// Belt-and-braces beyond afterEach/finally, matching shutdown.test.ts.
afterAll(() => {
  killAllSpawned()
})

/**
 * Local to this file rather than a new harness export: harness.ts's own
 * `enqueue` is hardcoded to the `slow` job's `{ count, durationMs, offset }`
 * body shape, and test/lifecycle/shutdown.test.ts's scenarios depend on that
 * exact signature. These scenarios need to target arbitrary job names with
 * arbitrary payloads instead — a genuinely different call shape, not an
 * extension of the existing one — so this is a plain, local `fetch` against
 * the same `/api/enqueue` route, not a harness change.
 */
const enqueueJob = async (
  target: AppHandle,
  body: { job: string, count?: number, offset?: number, payload?: Record<string, unknown> },
): Promise<{ ids: string[], errors: string[] }> => {
  const res = await fetch(`http://127.0.0.1:${target.port}/api/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`enqueue failed: ${res.status}`)
  return res.json() as Promise<{ ids: string[], errors: string[] }>
}

/**
 * Polls the append-only log for a specific entry rather than sleeping a
 * fixed duration — the same reasoning as harness.ts's own `waitForLogCount`,
 * but by predicate instead of count: these scenarios need to know a
 * SPECIFIC attempt landed (e.g. attempt 2, proving a retry happened), not
 * just that some N lines exist.
 */
const waitForLogEntry = async <T,>(
  target: AppHandle,
  predicate: (entry: T) => boolean,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((readLog(target) as unknown as T[]).some(predicate)) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`log entry matching predicate not found within ${timeoutMs}ms`)
}

describe.runIf(process.env.REDIS_URL)('retry across a real drain', () => {
  it('retries a job that fails once and completes it', async () => {
    app = await spawnApp({ role: 'both', driver: 'bullmq' })
    await waitForReady(app)

    await enqueueJob(app, { job: 'failing', count: 1, payload: { failUntilAttempt: 1 } })
    await waitForLogEntry<LogLine>(app, entry => entry.attempt === 2)

    const attempts = readLog(app).filter(e => e.jobId === 0).map(e => e.attempt).sort()

    // Exactly [1, 2]: attempt 1 failed, attempt 2 ran. A bare
    // `length >= 2` would pass on a driver retrying forever, and asserting
    // only `includes(2)` would pass on one that skipped attempt 1.
    expect(attempts).toEqual([1, 2])
  }, 30_000)

  it('stops after the configured attempts and does not retry forever', async () => {
    app = await spawnApp({ role: 'both', driver: 'bullmq' })
    await waitForReady(app)

    await enqueueJob(app, { job: 'failing', count: 1, payload: { failUntilAttempt: 99 } })
    await waitForLogEntry<LogLine>(app, entry => entry.attempt === 3)
    // Past the third attempt's fixed 100ms backoff, so a fourth would have
    // landed by now if the retry ceiling did not hold — a deliberate wait
    // past a deadline, not a readiness poll.
    await new Promise(r => setTimeout(r, 800))

    const attempts = readLog(app).filter(e => e.jobId === 0).map(e => e.attempt)

    // At-least-once delivery means a stalled-recovery redelivery can legally
    // add a duplicate, so attempts are COUNTED AND BOUNDED, never asserted
    // exact. The upper bound is what proves `attempts: 3` is a ceiling.
    expect(new Set(attempts)).toEqual(new Set([1, 2, 3]))
    expect(attempts.length).toBeLessThanOrEqual(6)
  }, 30_000)
})

describe.runIf(process.env.REDIS_URL)('invalid payloads dead-letter without consuming retries', () => {
  it('rejects at enqueue and never queues the job', async () => {
    app = await spawnApp({ role: 'both', driver: 'bullmq' })
    await waitForReady(app)

    const result = await enqueueJob(app, {
      job: 'typed',
      count: 1,
      payload: { id: 42 }, // schema wants a string
    })

    expect(result.ids).toHaveLength(0)
    expect(result.errors.join(' ')).toMatch(/failed validation/)

    // No positive signal exists to poll for here — the assertion IS that
    // nothing ever arrives. A short, fixed wait to give a wrongly-queued job
    // time to run and log is the deliberate exception the harness's own
    // convention calls out (waiting past a deadline), not a readiness wait.
    await new Promise(r => setTimeout(r, 500))
    expect(readLog(app)).toHaveLength(0)
  }, 30_000)

  it('applies the transform exactly once, in the worker', async () => {
    app = await spawnApp({ role: 'both', driver: 'bullmq' })
    await waitForReady(app)

    await enqueueJob(app, { job: 'typed', count: 1, payload: { id: '42' } })
    await waitForLogEntry<TypedLogLine>(app, entry => entry.jobId === 0)

    const entry = (readLog(app) as unknown as TypedLogLine[]).find(e => e.jobId === 0)!

    // Both halves. The handler must see a NUMBER (the transform ran) with
    // the right VALUE (it ran once, not twice — a second pass over 42 would
    // have failed z.string() and produced no log line at all).
    expect(entry.idType).toBe('number')
    expect(entry.idValue).toBe(42)
  }, 30_000)
})
