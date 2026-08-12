import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import {
  spawnApp, waitForReady, waitForActiveCount, waitForLogCount,
  enqueue, readLog, waitForExit, cleanup, summarise, flushRedis, namespaceRedisUrl,
  killAllSpawned, type AppHandle,
} from './harness'

const DRIVERS = (process.env.REDIS_URL ? ['memory', 'bullmq'] : ['memory']) as Array<'memory' | 'bullmq'>

let app: AppHandle | undefined

beforeAll(() => {
  // Point every consumer (the build, `flushRedis`, and every spawned app) at
  // a dedicated logical database rather than whatever REDIS_URL defaults to
  // (0) — `flushRedis` runs FLUSHDB, which would otherwise wipe an
  // operator's real data on a shared, non-ephemeral Redis. Mutating
  // process.env here, before the build reads it, is what makes the
  // playground's own `connection: { url: process.env.REDIS_URL }` bake in
  // the namespaced URL too.
  if (process.env.REDIS_URL) process.env.REDIS_URL = namespaceRedisUrl(process.env.REDIS_URL)

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

// Belt-and-braces beyond afterEach/finally: catches anything a bug in this
// file itself might leave running before the process exits (the module-level
// `process.on('exit')` in harness.ts is the last line of defense for a crash
// or SIGINT to the test runner itself).
afterAll(() => {
  killAllSpawned()
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

    // waitForReady already guarantees a 200 by construction — re-asserting
    // the status code here would prove nothing new. Assert on the BODY
    // instead, which waitForReady does not inspect.
    const res = await fetch(`http://127.0.0.1:${app.port}/_concierge/health`)
    const body = await res.json() as { state?: string, role?: string, queues?: string[] }
    expect(body.state).toBe('running')
    expect(body.role).toBe('both')
    expect(body.queues).toContain('default')
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
    // Assert a BOUND, not zero: at-least-once means a clean drain may
    // legally re-run a job, so asserting zero duplicates would flake. But
    // the bound has to actually bite — with a batch of 5, "fewer than
    // completed.size" tolerates 4-of-5 duplicating, which a driver that
    // re-runs almost everything would still pass. Capping at 1 means at
    // most 20% of the batch may legitimately duplicate before this fails.
    expect(duplicates).toBeLessThanOrEqual(1)
    console.log(`[${driver}] duplicates: ${duplicates}/${completed.size}`)
  }, 90_000)

  // There is deliberately no lifecycle scenario asserting "health returns
  // 503 while draining" over a real HTTP connection. On the node-server
  // preset used here, Nitro's own graceful-shutdown wrapper
  // (http-graceful-shutdown) destroys every connection — brand new AND
  // already-established idle-keepalive sockets alike — within milliseconds
  // of receiving the shutdown signal, independent of this module's own
  // supervisor state, before this route is ever consulted for that
  // request. Verified empirically, twice: 100 sequential curl requests
  // (fresh connection each) across a full 2s drain window all failed with
  // a connection reset, and a persistent Node fetch() keep-alive pool
  // polling every 5ms across the same window saw "fetch failed" on every
  // attempt — zero responses of any kind, in either experiment. Confirmed
  // further by deliberately disabling this module's own
  // `supervisor?.setState('draining')` call (src/runtime/server/shutdown.ts)
  // and rerunning an earlier version of this scenario: it still passed,
  // because Nitro's connection teardown does not depend on this module's
  // state at all.
  //
  // So: on this preset, an operator does not observe a 503 during drain —
  // they observe connection refusal, which is Nitro's behaviour, not this
  // module's to test. Every attempt at an end-to-end assertion here either
  // tautologises (accepts its own "unreachable" error as proof, which any
  // unrelated failure would also satisfy) or ends up testing Nitro instead
  // of this module. Two such attempts shipped and were both reverted for
  // exactly that reason — see the fix-round history in
  // .superpowers/sdd/2026-08-12-concierge-v2-phase1-lifecycle/task-12-report.md
  // before reintroducing coverage here.
  //
  // The guarantee IS covered, just not at this layer: `healthStatus('draining')
  // === 503` is asserted directly, in-process, with no Nitro connection
  // layer involved, in test/unit/health.test.ts. That test correctly fails
  // if the state-flip logic in shutdown.ts breaks. Leave it there.

  it('exits immediately on a second signal', async () => {
    app = await spawnApp({ driver, role: 'both', shutdownTimeout: 20_000 })
    await waitForReady(app)
    await enqueue(app, 10, 5000)
    await new Promise(r => setTimeout(r, 400))

    app.proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 200))
    const started = Date.now()
    app.proc.kill('SIGTERM')

    const code = await waitForExit(app, 10_000)
    // A clean single-signal drain here would take ~4.5s more (10 jobs at
    // concurrency 5, 5000ms each, minus the ~600ms already elapsed) and
    // exit 0 via Nitro's own graceful-shutdown path — comfortably inside a
    // loose "under 8s" bound, which the double-signal escape hatch could be
    // deleted entirely and still satisfy. Only the second-signal path exits
    // this fast AND with this exact code (128 + SIGTERM's signal number,
    // see src/runtime/server/shutdown.ts) — both together is what a clean
    // drain cannot produce by construction, not just "eventually exited".
    expect(Date.now() - started).toBeLessThan(1000)
    expect(code).toBe(143)
  }, 60_000)

  it('force-closes when the drain exceeds the budget', async () => {
    app = await spawnApp({ driver, stalledInterval: 1000, shutdownTimeout: 1000 })
    await waitForReady(app)
    await enqueue(app, 5, 10_000)
    await waitForActiveCount(app, 5)

    app.proc.kill('SIGTERM')
    await waitForExit(app, 30_000)

    // The process exiting proves nothing on its own: runDrain() (see
    // src/runtime/server/shutdown.ts) always resolves, never rejects, so an
    // absent force-close path would just keep draining for the full 10s job
    // duration and still exit — non-null, non-flaky, and still inside a
    // generous wait, satisfying the old assertion without forcing ever
    // having happened. Forcing has two independently observable
    // consequences instead: fewer completions than were in flight (5 jobs
    // that need 10s cannot finish within a 1s budget), and the driver's own
    // "force-closed" log line.
    const { completed } = summarise(readLog(app))
    expect(completed.size).toBeLessThan(5)
    expect(app.getStderr()).toContain('force-closed with')
  }, 90_000)
})

describe('guardrails', () => {
  it('refuses to boot the memory driver under role: worker', async () => {
    app = await spawnApp({ driver: 'memory', role: 'worker' })
    const code = await waitForExit(app, 30_000)
    // `not.toBe(0)` alone is satisfied by a port collision, a missing
    // module, any unrelated boot throw, or the process being killed by a
    // signal (code null) — none of which test the guardrail. This
    // guardrail's own exit path is a specific, unconditional `process.exit(1)`
    // (src/templates.ts), so pin the code AND require the guardrail's own
    // message text in stderr.
    expect(code).toBe(1)
    expect(app.getStderr()).toContain('cannot be used with role "worker"')
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

describe.runIf(process.env.REDIS_URL)('two-process production shape (web + worker)', () => {
  it('draining the worker does not touch web, and completions come from the worker pid', async () => {
    // Every drain scenario above runs role: 'both' in a single process. That
    // only IMPLIES the real deployment target — a separate web process and a
    // separate worker process sharing one bullmq/Redis backend — drains
    // correctly; it never demonstrates it. This test spawns that exact
    // shape: two independent OS processes, different ports, only one of
    // which (worker) is ever sent a signal.
    //
    // The memory driver cannot stand in here: it keeps state in-process, so
    // guardrailDiagnostics (src/runtime/server/guardrails.ts) refuses any
    // role other than 'both' when it is selected — this scenario is
    // bullmq-only by necessity, not by choice.
    let web: AppHandle | undefined
    let worker: AppHandle | undefined

    // Deliberately outside the 3100-3499 range every other scenario in this
    // file draws its random port from, so a slow-to-release process left
    // over from an earlier scenario cannot collide with either of these.
    const WEB_PORT = 3900
    const WORKER_PORT = 3901

    try {
      web = await spawnApp({ role: 'web', driver: 'bullmq', port: WEB_PORT })
      worker = await spawnApp({ role: 'worker', driver: 'bullmq', port: WORKER_PORT, shutdownTimeout: 20_000 })
      await waitForReady(web)
      await waitForReady(worker)

      // Enqueue via the WEB process's HTTP API. This is the whole point of
      // the split: the producer needs no consumers of its own. Enqueuing
      // against `worker` instead would 503 — under role: 'worker', the role
      // gate (src/runtime/server/middleware/role-gate.ts) serves nothing but
      // /_concierge/health, so web is the only process in this shape that
      // can accept the request at all.
      const { ids } = await enqueue(web, 5, 300)
      expect(ids.length).toBe(5)

      // Poll the WORKER's health endpoint, not web's: role: 'web' starts no
      // consumers (src/runtime/server/supervisor.ts), so web's activeCount
      // is permanently 0 no matter how long anything waits on it. This also
      // proves the jobs enqueued via web actually crossed into the worker
      // process rather than sitting unclaimed.
      await waitForActiveCount(worker, 5)

      // SIGTERM the worker only. Web is never signalled and keeps running
      // throughout.
      worker.proc.kill('SIGTERM')
      await waitForExit(worker)

      const { completed, duplicates, pids } = summarise(readLog(worker))
      expect(completed.size).toBe(5)
      // Same reasoning as the single-process drain scenario above: at least
      // once means a clean drain may legally re-run a job, so zero would
      // flake, but the bound still has to bite.
      expect(duplicates).toBeLessThanOrEqual(1)
      // Every completion came from the WORKER's pid specifically — not web's,
      // and not some other stray process — proving the work genuinely ran in
      // the dedicated worker process this scenario spawned.
      expect(pids.size).toBe(1)
      expect(pids.has(worker.proc.pid!)).toBe(true)

      // Killing a worker must not affect web: still reachable, still
      // reporting itself as running, after the worker it shares Redis with
      // has fully exited.
      const res = await fetch(`http://127.0.0.1:${web.port}/_concierge/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as { state?: string, role?: string }
      expect(body.state).toBe('running')
      expect(body.role).toBe('web')
    }
    finally {
      if (worker) cleanup(worker)
      if (web) cleanup(web)
    }
  }, 90_000)
})
