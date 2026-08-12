import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import {
  spawnApp, waitForReady, waitForActiveCount, waitForLogCount, enqueue, readLog, waitForExit, cleanup,
  summarise, flushRedis, type AppHandle,
} from './harness'

const DRIVERS = (process.env.REDIS_URL ? ['memory', 'bullmq'] : ['memory']) as Array<'memory' | 'bullmq'>

let app: AppHandle | undefined

beforeAll(() => {
  execSync('pnpm dev:build', { stdio: 'inherit', timeout: 300_000 })
}, 320_000)

// Every bullmq scenario shares one queue name in one Redis instance; several
// scenarios deliberately crash processes mid-job. Without a flush, one
// scenario's abandoned jobs bleed into the next scenario's counts. A no-op
// without REDIS_URL.
beforeEach(async () => {
  await flushRedis()
})

afterEach(() => {
  if (app) cleanup(app)
  app = undefined
})

// pnpm dev:build (nuxi build) can succeed while the resulting output still
// fails to boot — that gap let a boot-breaking bug survive two review
// cycles. This scenario spawns the real built artifact and fails loudly if
// it never becomes ready, independent of any of the heavier drain
// scenarios below. Uses the memory driver, so it needs no Redis.
describe('boot smoke test', () => {
  it('the built output actually starts and serves the health endpoint', async () => {
    app = await spawnApp({ driver: 'memory', role: 'both' })
    await waitForReady(app)

    const res = await fetch(`http://127.0.0.1:${app.port}/_concierge/health`)
    expect(res.status).toBe(200)
  }, 60_000)
})

describe.each(DRIVERS)('lifecycle: %s driver', (driver) => {
  it('drains all in-flight jobs on SIGTERM', async () => {
    app = await spawnApp({ driver, role: 'both', shutdownTimeout: 20_000 })
    await waitForReady(app)
    // The guarantee under test is "in-flight jobs survive SIGTERM", not
    // "the whole backlog gets processed before exit" — pause() (see
    // src/runtime/server/drivers/memory.ts and bullmq.ts) stops fetching
    // NEW jobs immediately, it does not keep draining the queue up to the
    // shutdown budget. The playground's queue concurrency is fixed at 5
    // (playground/nuxt.config.ts, worker.queues.default), so the job count
    // here matches it: with more jobs than concurrency, some would never be
    // dispatched before the signal and "abandoned in the queue forever" is
    // a different (and, for the memory driver, expected/lossy) behaviour
    // from the one this test asserts on.
    await enqueue(app, 5, 300)

    // Poll for dispatch rather than a fixed sleep: the in-process memory
    // driver picks jobs up in single-digit milliseconds, but bullmq's
    // worker has to round-trip real Redis to claim each job, so a sleep
    // tuned for one driver either flakes (too short for bullmq) or wastes
    // time (too long for memory).
    await waitForActiveCount(app, 5)
    app.proc.kill('SIGTERM')
    await waitForExit(app)

    const { completed, duplicates } = summarise(readLog(app))
    expect(completed.size).toBe(5)
    // Assert a BOUND, not zero. At-least-once means a clean drain may legally
    // re-run a job, so asserting zero duplicates would flake — but asserting
    // nothing would let a driver that re-runs every job pass. A clean SIGTERM
    // drain should not duplicate the majority of the batch.
    expect(duplicates).toBeLessThan(completed.size)
    console.log(`[${driver}] duplicates: ${duplicates}/${completed.size}`)
  }, 90_000)

  it('reports 503 on health once draining', async () => {
    app = await spawnApp({ driver, role: 'both' })
    await waitForReady(app)
    await enqueue(app, 5, 2000)

    app.proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 200))

    const res = await fetch(`http://127.0.0.1:${app.port}/_concierge/health`).catch(() => null)
    if (res) expect(res.status).toBe(503)

    await waitForExit(app)
  }, 90_000)

  it('exits immediately on a second signal', async () => {
    app = await spawnApp({ driver, role: 'both', shutdownTimeout: 20_000 })
    await waitForReady(app)
    await enqueue(app, 10, 5000)
    await new Promise(r => setTimeout(r, 400))

    app.proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 200))
    const started = Date.now()
    app.proc.kill('SIGTERM')

    await waitForExit(app, 10_000)
    expect(Date.now() - started).toBeLessThan(8000)
  }, 60_000)

  it('force-closes when the drain exceeds the budget', async () => {
    app = await spawnApp({ driver, stalledInterval: 1000, shutdownTimeout: 1000 })
    await waitForReady(app)
    await enqueue(app, 5, 10_000)
    await new Promise(r => setTimeout(r, 500))

    app.proc.kill('SIGTERM')
    const code = await waitForExit(app, 30_000)

    expect(code).not.toBeNull()
  }, 90_000)
})

describe('guardrails', () => {
  it('refuses to boot the memory driver under role: worker', async () => {
    app = await spawnApp({ driver: 'memory', role: 'worker' })
    const code = await waitForExit(app, 30_000)
    expect(code).not.toBe(0)
  }, 60_000)
})

describe.runIf(process.env.REDIS_URL)('bullmq recovery', () => {
  it('redelivers jobs abandoned by SIGKILL', async () => {
    // Both handles are cleaned up in `finally`, not just after the final
    // assertion: this test spawns two real bullmq workers against the one
    // shared Redis instance, and an assertion failure that skipped cleanup
    // would leak a live worker process that keeps consuming jobs from the
    // "default" queue in the background — silently corrupting every other
    // bullmq scenario's counts, including ones in a later, unrelated test
    // run, since the leaked process is a real OS process independent of
    // the test runner.
    let first: AppHandle | undefined
    let second: AppHandle | undefined

    try {
      first = await spawnApp({ driver: 'bullmq', stalledInterval: 1000 })
      await waitForReady(first)

      // A short batch that completes under process 1 before it is killed.
      // Without this, "two distinct pids" could never be satisfied by
      // construction: a process that is SIGKILLed can never itself log a
      // completion for work it was still running, so if every enqueued job
      // is still in flight at kill time, only the second process's pid can
      // ever appear and the assertion below would be unsatisfiable rather
      // than a real signal. offset: 0 -> seq 0..4.
      await enqueue(first, 5, 200, 0)
      await waitForLogCount(first, 5) // let the short batch actually finish under process 1

      // A second batch that is still mid-flight when SIGKILL lands, so it
      // gets abandoned, marked stalled, and redelivered to whichever
      // process is holding the queue afterwards. offset: 5 -> seq 5..9, so
      // its completions are distinguishable from the short batch's above
      // instead of colliding on the same seq 0..4 jobIds.
      await enqueue(first, 5, 4000, 5)
      await waitForActiveCount(first, 5)

      first.proc.kill('SIGKILL')
      await waitForExit(first, 10_000)

      // Same log so the second process appends to the first's records.
      second = await spawnApp({
        driver: 'bullmq',
        stalledInterval: 1000,
        logPath: first.logPath,
      })
      await waitForReady(second)

      // BullMQ only reclaims an abandoned job once its lock expires, which
      // is governed by `lockDuration` (default 30s), NOT `stalledInterval` —
      // stalledInterval only controls how often BullMQ checks for locks
      // that have ALREADY expired. This module does not currently expose
      // lockDuration, so recovery genuinely takes up to ~30s here; poll
      // instead of guessing a fixed sleep so the test takes as long as
      // recovery actually takes, no longer.
      await waitForLogCount(second, 10, 60_000)

      const { completed, pids } = summarise(readLog(second))
      expect(completed.size).toBe(10)
      // Two distinct pids proves work actually crossed the restart.
      expect(pids.size).toBe(2)
    }
    finally {
      if (second) cleanup(second)
      if (first) cleanup(first)
    }
  }, 150_000)
})
