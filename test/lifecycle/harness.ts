import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import IORedis from 'ioredis'
import { Queue } from 'bullmq'

export interface AppHandle {
  proc: ChildProcess
  port: number
  logPath: string
  stop: () => void
  /** Everything the child has written to stderr so far, e.g. to assert on a specific log line. */
  getStderr: () => string
  /** Everything the child has written to stdout so far. */
  getStdout: () => string
}

export interface SpawnOptions {
  role?: 'web' | 'worker' | 'both'
  driver?: 'memory' | 'bullmq'
  shutdownTimeout?: number
  stalledInterval?: number
  port?: number
  logPath?: string
  /**
   * Name of a job that should throw on its first attempt only. Read by
   * `playground/server/jobs/heartbeat-digest.ts` (the only fixture that
   * checks it) via `CONCIERGE_FAIL_FIRST_ATTEMPT` — a bespoke, test-only env
   * var, not a `NUXT_`-prefixed runtime-config override, since it names a
   * behaviour the module itself has no concept of.
   */
  failFirstAttempt?: string
  /**
   * Whether the playground's declared cron jobs are scheduled at all.
   *
   * **Defaults to `false`, and that default is load-bearing.**
   * `playground/server/jobs/heartbeat-digest.ts` runs every minute and appends
   * to `CONCIERGE_TEST_LOG` — the SAME log the scenario that spawned this
   * process is asserting on. Every scenario here runs a worker role, so
   * without this the digest reconciles and fires in scenarios that have
   * nothing to do with cron, and its `{ name, tick, tz, attempt }` line lands
   * among their `{ jobId, attempt, pid, id }` ones.
   *
   * That is not hypothetical: it turned CI's SIGKILL-recovery scenario into
   * `expected 11 to be 10`, because `summarise` counted the digest line's
   * absent `jobId` as an eleventh distinct job. It is timing-dependent — the
   * scenario polls for 10 LINES, so a digest line arriving before the tenth
   * real completion masks the problem — which is why it passed locally and
   * failed on a slower runner.
   *
   * The log is only the loudest symptom. A digest job firing mid-scenario also
   * occupies a worker slot and adds queue depth, so `waitForActiveCount` and
   * drain-timing assertions are exposed to it too.
   *
   * `test/lifecycle/cron.test.ts` opts in via `startApp`.
   */
  cronEnabled?: boolean
}

const OUTPUT = 'playground/.output/server/index.mjs'

/**
 * Every process this file spawns, so a crash or a SIGINT to the vitest
 * worker itself (not just a normal test failure, which `afterEach`/`finally`
 * already handle) cannot leave one running. This is exactly the kind of
 * pollution that cost real debugging time earlier: a leaked worker process
 * kept consuming jobs from a shared Redis queue across separate,
 * independent `pnpm test:lifecycle` invocations.
 */
const spawned = new Set<ChildProcess>()

/**
 * The subset of `spawned` that was launched with `detached: true`
 * (`spawnDevApp` only — see its doc comment). For these, a plain
 * `proc.kill()` only reaches the immediate `pnpm` process, not the `nuxi`
 * child it forks, so this belt-and-braces sweep must also signal the
 * negated pid to reach the whole process group, exactly like their own
 * `stop()` does.
 */
const detachedGroups = new Set<ChildProcess>()

const killAll = () => {
  for (const proc of spawned) {
    try {
      if (detachedGroups.has(proc) && proc.pid) process.kill(-proc.pid, 'SIGKILL')
      else proc.kill('SIGKILL')
    }
    catch { /* already gone */ }
  }
  spawned.clear()
  detachedGroups.clear()
}

process.on('exit', killAll)

/** Exposed so a test file's own `afterAll` can also invoke it as a belt-and-braces sweep. */
export const killAllSpawned = killAll

export const spawnApp = async (opts: SpawnOptions = {}): Promise<AppHandle> => {
  const port = opts.port ?? 3100 + Math.floor(Math.random() * 400)
  const logPath = opts.logPath ?? join(tmpdir(), `concierge-${randomUUID()}.log`)
  // Only create/truncate when the caller did not supply an existing path.
  // The SIGKILL-recovery scenario passes the FIRST process's own logPath to
  // the SECOND process so it can append to the first's records — truncating
  // unconditionally here would wipe out everything the first process wrote
  // before the second ever started.
  if (!opts.logPath) writeFileSync(logPath, '')

  const proc = spawn('node', [OUTPUT], {
    env: {
      ...process.env,
      PORT: String(port),
      NITRO_PORT: String(port),
      // CONCIERGE_ROLE is a first-class, documented, validated env var read
      // directly by the generated plugin (src/runtime/server/role.ts throws
      // on an invalid value) — it stays a bespoke read on purpose.
      CONCIERGE_ROLE: opts.role ?? 'both',
      CONCIERGE_TEST_LOG: logPath,
      // Undefined when the caller does not ask for it — Node strips env keys
      // whose value is `undefined` before spawning, same as VITEST below.
      CONCIERGE_FAIL_FIRST_ATTEMPT: opts.failFirstAttempt,
      // Driver and the two timeouts are NOT bespoke env vars: Nuxt already
      // applies runtime env overrides to `runtimeConfig.concierge.*` using
      // the `NUXT_` prefix (verified against the built output's own
      // `envPrefix: "NUXT_"`), so a per-process override needs no new,
      // undocumented mechanism. Path: concierge.driver ->
      // NUXT_CONCIERGE_DRIVER; concierge.worker.shutdownTimeout ->
      // NUXT_CONCIERGE_WORKER_SHUTDOWN_TIMEOUT; concierge.bullmq.stalledInterval
      // -> NUXT_CONCIERGE_BULLMQ_STALLED_INTERVAL.
      NUXT_CONCIERGE_DRIVER: opts.driver ?? 'memory',
      NUXT_CONCIERGE_WORKER_SHUTDOWN_TIMEOUT: String(opts.shutdownTimeout ?? 20_000),
      NUXT_CONCIERGE_BULLMQ_STALLED_INTERVAL: String(opts.stalledInterval ?? 1000),
      // OFF unless the scenario asks for it — see SpawnOptions.cronEnabled.
      // Same NUXT_ override mechanism as the three above; `concierge.cron.enabled`
      // -> NUXT_CONCIERGE_CRON_ENABLED. `false` here does not merely skip
      // scheduling in this process, it reconciles with an empty declared set,
      // so a schedule left in Redis by an earlier scenario is pruned rather
      // than inherited.
      NUXT_CONCIERGE_CRON_ENABLED: String(opts.cronEnabled ?? false),
      // Keep Nitro's own budget above ours so it is not the limiting factor.
      NITRO_SHUTDOWN_TIMEOUT: '25000',
      NODE_ENV: 'production',
      // Defense in depth: the generated plugin no longer guards its fatal
      // boot-error exit on this variable (that guard was removed — it was
      // protecting a code path the unit suite never actually loads), but
      // this spawned process is a real, separate one regardless, and
      // stripping VITEST here costs nothing. Node strips env keys whose
      // value is `undefined` before spawning.
      VITEST: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  spawned.add(proc)
  proc.once('exit', () => spawned.delete(proc))

  let stdout = ''
  let stderr = ''
  proc.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString()
    if (process.env.HARNESS_DEBUG) console.log(`[app] ${d}`)
  })
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
    if (process.env.HARNESS_DEBUG) console.error(`[app] ${d}`)
  })

  return {
    proc,
    port,
    logPath,
    stop: () => { try { proc.kill('SIGKILL') } catch { /* already gone */ } },
    getStdout: () => stdout,
    getStderr: () => stderr,
  }
}

export interface SpawnDevOptions {
  driver?: 'memory' | 'bullmq'
  port?: number
  logPath?: string
}

/**
 * Spawns `nuxi dev playground` rather than the built output.
 *
 * Necessary, not preferred: every dashboard route is registered only under
 * `nuxt.options.dev`, so the production artifact `spawnApp` runs contains no
 * dashboard to test. NODE_ENV is left at development for the same reason —
 * forcing production here would gate off the very routes under test.
 *
 * Readiness takes far longer than for the built output (Vite must compile the
 * app on first request), so callers should pass a generous timeout to
 * waitForReady.
 *
 * Spawned `detached: true` and stopped by killing the whole process group
 * (`process.kill(-pid, 'SIGKILL')`), not just the immediate child. `nuxi dev`
 * forks by default (`nuxi dev --help` shows `-f, --fork` defaulting to
 * `true`), and `pnpm dev` itself is a wrapper around `nuxi`, so a plain
 * `proc.kill('SIGKILL')` on just the top-level `pnpm` process was verified
 * empirically (via `lsof -i` for this port range immediately after
 * `cleanup()`/`killAllSpawned()` ran, with no detach/group-kill in place) to
 * leave the forked Nuxt child bound to the port. Killing the negated pid
 * signals every process in the group `detached: true` created, which is what
 * actually frees the port — confirmed by the same `lsof` check coming back
 * empty once this was added.
 */
export const spawnDevApp = async (opts: SpawnDevOptions = {}): Promise<AppHandle> => {
  const port = opts.port ?? 3600 + Math.floor(Math.random() * 300)
  const logPath = opts.logPath ?? join(tmpdir(), `concierge-dev-${randomUUID()}.log`)
  if (!opts.logPath) writeFileSync(logPath, '')

  const proc = spawn('pnpm', [
    'dev',
    '--port', String(port),
    // Verified empirically: Nuxt's dev server (unlike the built output
    // `spawnApp` runs) binds only the IPv6 loopback (`::1`) when no host is
    // given — `curl http://127.0.0.1:<port>` got connection-refused while
    // `curl http://localhost:<port>` (resolving to `::1`) succeeded against
    // the same process. Every helper in this file (`waitForReady`, and every
    // test's own `fetch`) targets `127.0.0.1` explicitly, so without this
    // flag the dev server would never be reachable at all.
    '--host', '127.0.0.1',
  ], {
    env: {
      ...process.env,
      PORT: String(port),
      NITRO_PORT: String(port),
      CONCIERGE_ROLE: 'both',
      CONCIERGE_TEST_LOG: logPath,
      NUXT_CONCIERGE_DRIVER: opts.driver ?? 'memory',
      // Deliberately NOT production: see the doc comment above.
      NODE_ENV: 'development',
      VITEST: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // See the doc comment above: this is what makes `-proc.pid` a valid
    // process-group id to signal in `stop()` below.
    detached: true,
  })

  spawned.add(proc)
  // Registered so `killAllSpawned`'s belt-and-braces sweep also group-kills
  // this process if it ever runs before this handle's own `stop()` does
  // (e.g. a crash or SIGINT to the test runner itself) — without this, that
  // sweep would fall through to a plain `proc.kill()` on just the `pnpm`
  // wrapper and leave the forked `nuxi` child (and the port) behind.
  detachedGroups.add(proc)
  proc.once('exit', () => { spawned.delete(proc); detachedGroups.delete(proc) })

  let stdout = ''
  let stderr = ''
  proc.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString()
    if (process.env.HARNESS_DEBUG) console.log(`[dev] ${d}`)
  })
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
    if (process.env.HARNESS_DEBUG) console.error(`[dev] ${d}`)
  })

  return {
    proc,
    port,
    logPath,
    stop: () => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
        else proc.kill('SIGKILL')
      }
      catch { /* already gone */ }
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  }
}

/**
 * Polls the health endpoint rather than sleeping a fixed duration. Fixed sleeps
 * are how lifecycle tests become flaky, and a flaky lifecycle test gets skipped,
 * which removes the only regression signal for the shutdown guarantee.
 */
export const waitForReady = async (app: AppHandle, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (app.proc.exitCode !== null) {
      throw new Error(`app exited early with code ${app.proc.exitCode}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/_concierge/health`)
      if (res.status === 200) return
    }
    catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 100))
  }

  throw new Error(`app did not become ready within ${timeoutMs}ms`)
}

/**
 * Polls the health endpoint's `activeCount` (see healthPayload in
 * src/runtime/server/routes/health.ts) rather than sleeping a fixed
 * duration before sending a signal. Dispatch latency between "enqueue
 * returned" and "the job is actually running" is near-instant for the
 * in-process memory driver but involves real Redis round-trips for bullmq
 * — a fixed sleep tuned for one is either too short (flaky under-count) or
 * needlessly long for the other. Callers that need "N jobs are genuinely
 * in flight before I signal" should wait on this instead of a sleep.
 */
export const waitForActiveCount = async (
  app: AppHandle,
  count: number,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (app.proc.exitCode !== null) {
      throw new Error(`app exited early with code ${app.proc.exitCode}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/_concierge/health`)
      if (res.status === 200) {
        const body = await res.json() as { activeCount?: number }
        if ((body.activeCount ?? 0) >= count) return
      }
    }
    catch { /* not reachable yet */ }
    await new Promise(r => setTimeout(r, 25))
  }

  throw new Error(`activeCount did not reach ${count} within ${timeoutMs}ms`)
}

/**
 * The dedicated logical database every lifecycle test agrees on. Shared as a
 * named constant (rather than each of `namespaceRedisUrl`'s default
 * parameter and `flushRedis`'s own safety check separately hardcoding `15`)
 * so the two can never drift apart.
 */
const LIFECYCLE_REDIS_DB = 15

/**
 * Points lifecycle tests at a dedicated Redis logical database rather than
 * whatever database the supplied REDIS_URL defaults to (0). `flushRedis`
 * below runs `FLUSHDB`, which would otherwise wipe an operator's real data
 * on a shared, non-ephemeral Redis. Call this once, before anything reads
 * REDIS_URL to build or spawn — the URL is rewritten in place so every
 * consumer (the build, `flushRedis`, and every spawned app, since the
 * connection URL is threaded through unchanged) agrees on the same
 * isolated database.
 *
 * Uses `URL` rather than a regex substitution: a regex matching only a
 * trailing `/\d+` silently APPENDS instead of replacing for any other URL
 * shape (e.g. `redis://host:6379?family=6` -> `...?family=6/15`, which is
 * not a database selector at all; `redis://host:6379/` ->
 * `redis://host:6379//15`), leaving the connection on database 0 with no
 * indication anything went wrong. `flushRedis` would then FLUSHDB against
 * database 0 — exactly the outcome this function exists to prevent. Setting
 * `pathname` explicitly on a parsed URL cannot silently append, and throws
 * loudly on input that cannot be parsed as a URL at all rather than
 * proceeding with something unnamespaced.
 */
export const namespaceRedisUrl = (url: string, db: number = LIFECYCLE_REDIS_DB): string => {
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch (error) {
    throw new Error(
      `[lifecycle harness] cannot namespace REDIS_URL "${url}" to a dedicated database: `
      + `${error instanceof Error ? error.message : String(error)}. Refusing to proceed, `
      + `since flushRedis() would otherwise FLUSHDB against whatever database this URL `
      + `actually resolves to.`,
      { cause: error },
    )
  }
  parsed.pathname = `/${db}`
  return parsed.toString()
}

/**
 * Lifecycle scenarios deliberately crash processes mid-job (SIGKILL, forced
 * close), leaving BullMQ state (locked/active entries, stalled jobs) behind
 * in Redis. Every bullmq scenario shares the same queue name
 * (`default`, from playground/nuxt.config.ts), so without flushing between
 * tests, one scenario's abandoned jobs get silently picked up and completed
 * by the next scenario's fresh process — corrupting that scenario's own
 * completed/duplicate counts. A no-op when REDIS_URL is unset so memory-only
 * runs (the common contributor path, no Redis required) pay nothing.
 *
 * Only ever flushes the database selected by REDIS_URL's own path segment
 * (see `namespaceRedisUrl`), never the operator's default database. The
 * check below is independent of `namespaceRedisUrl` having actually run
 * correctly — it reads the db ioredis itself resolved from the connection
 * string, immediately before the one genuinely destructive call in this
 * whole file, so a regression in the namespacing logic (or REDIS_URL being
 * set directly, bypassing it) still cannot result in FLUSHDB running
 * against database 0.
 */
export const flushRedis = async (): Promise<void> => {
  const url = process.env.REDIS_URL
  if (!url) return

  const client = new IORedis(url, { maxRetriesPerRequest: 0, lazyConnect: true })
  try {
    await client.connect()

    if (client.options.db !== LIFECYCLE_REDIS_DB) {
      throw new Error(
        `[lifecycle harness] refusing to FLUSHDB: connected to database ${client.options.db}, `
        + `expected the dedicated lifecycle-test database ${LIFECYCLE_REDIS_DB}. This must never `
        + `run against an operator's real database.`,
      )
    }

    await client.flushdb()
  }
  finally {
    client.disconnect()
  }
}

/**
 * `offset` shifts the `seq` payload field so multiple calls against the
 * same app produce non-colliding job identities (e.g. a short batch at
 * seq 0..4 and a long batch at seq 5..9) — without it, every call's `seq`
 * restarts at 0, and a per-jobId summary (see `summarise`) cannot tell two
 * different batches' completions apart.
 */
export const enqueue = async (app: AppHandle, count: number, durationMs: number, offset = 0) => {
  const res = await fetch(`http://127.0.0.1:${app.port}/api/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count, durationMs, offset }),
  })
  if (!res.ok) throw new Error(`enqueue failed: ${res.status}`)
  return res.json() as Promise<{ ids: string[] }>
}

export interface LogLine { jobId: number, attempt: number, pid: number, id: string }

/**
 * Tolerates exactly one unparseable line: the LAST one, and only the last
 * one. SIGKILL (used deliberately by several scenarios to simulate a crash)
 * can interrupt `appendFileSync` mid-write, leaving a torn, partial JSON
 * line as the file's final line — an expected artifact of that specific
 * scenario, not a bug. A malformed line ANYWHERE ELSE is a real bug in the
 * job or the harness and must still throw loudly rather than being silently
 * dropped.
 *
 * Extracted from `readLog` (rather than duplicated) so the cron scenario's
 * `readHeartbeatLog` below — a different line shape entirely
 * (`name`/`tick`/`tz`/`attempt`, not `jobId`/`id`/`pid`) — tolerates that
 * exact same torn-line case identically, instead of quietly diverging.
 */
const parseLogFile = (path: string): unknown[] => {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)

  return lines
    .map((line, i) => {
      try {
        return JSON.parse(line) as unknown
      }
      catch (error) {
        if (i === lines.length - 1) return undefined
        throw error
      }
    })
    .filter(line => line !== undefined)
}

export const readLog = (app: AppHandle): LogLine[] => parseLogFile(app.logPath) as LogLine[]

/**
 * Polls the append-only log rather than sleeping a fixed duration, for a
 * scenario that needs a batch to have genuinely finished (not just started)
 * before moving on — e.g. proving a job completed under one process before
 * that process is killed.
 */
export const waitForLogCount = async (app: AppHandle, count: number, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (readLog(app).length >= count) return
    await new Promise(r => setTimeout(r, 25))
  }

  throw new Error(`log did not reach ${count} lines within ${timeoutMs}ms`)
}

export const waitForExit = (app: AppHandle, timeoutMs = 40_000): Promise<number | null> =>
  new Promise((resolve, reject) => {
    if (app.proc.exitCode !== null) return resolve(app.proc.exitCode)
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs)
    app.proc.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })

export const cleanup = (app: AppHandle) => {
  app.stop()
  try { rmSync(app.logPath) } catch { /* ignore */ }
}

/** Distinct job seqs seen, and how many ran more than once. */
export const summarise = (lines: LogLine[]) => {
  const counts = new Map<number, number>()
  for (const l of lines) {
    // A line that is not a job-completion record must not be counted as one.
    // Without this the failure is an off-by-one — `undefined` becomes an extra
    // key in `completed`, and `pids` gains an extra member — which reads as
    // "the driver ran one job too many" and sends you looking at the driver.
    // That is exactly how a cron fixture appending to a shared log turned into
    // CI's `expected 11 to be 10`. Throwing names the real problem instead.
    if (typeof l.jobId !== 'number') {
      throw new Error(
        `[lifecycle] a non-job line reached summarise(): ${JSON.stringify(l)}. `
        + `Something other than a job fixture is appending to CONCIERGE_TEST_LOG `
        + `for this scenario — check whether a schedule is live that should not be `
        + `(see SpawnOptions.cronEnabled).`,
      )
    }
    counts.set(l.jobId, (counts.get(l.jobId) ?? 0) + 1)
  }
  return {
    completed: new Set(counts.keys()),
    duplicates: [...counts.entries()].filter(([, n]) => n > 1).length,
    pids: new Set(lines.map(l => l.pid)),
  }
}

// ---------------------------------------------------------------------------
// Cron scheduler harness (test/lifecycle/cron.test.ts)
// ---------------------------------------------------------------------------

/** One line `playground/server/jobs/heartbeat-digest.ts` appends per attempt. */
export interface HeartbeatLogLine { name: string, tick?: number, tz?: string, attempt: number }

export const readHeartbeatLog = (app: AppHandle): HeartbeatLogLine[] =>
  parseLogFile(app.logPath) as HeartbeatLogLine[]

/** The subset of `ScheduleSummary` these scenarios need to assert on. */
export interface SchedulerSummary { id: string, jobName: string }

/**
 * Opens a short-lived BullMQ `Queue` client directly against Redis and closes
 * it again, rather than going through this app's own HTTP API — the
 * `/_concierge/api/schedules` route only exists on a DEV server
 * (`nuxt.options.dev`), and every scenario in cron.test.ts spawns the real
 * BUILT output via `startApp`/`spawnApp`, which never registers it. This is
 * the same pair of calls `src/runtime/server/drivers/bullmq.ts`'s own
 * `schedule.list`/`schedule.upsert` make — reading and writing scheduler
 * state exactly the way the driver itself does, just from outside the app
 * process.
 */
const withQueue = async <T>(queueName: string, fn: (queue: Queue) => Promise<T>): Promise<T> => {
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error(
      '[lifecycle harness] REDIS_URL is required to talk to a BullMQ scheduler directly — '
      + 'cron.test.ts must stay behind describe.runIf(process.env.REDIS_URL).',
    )
  }
  const queue = new Queue(queueName, { connection: { url } })
  try {
    return await fn(queue)
  }
  finally {
    await queue.close()
  }
}

export interface StartAppOptions {
  role?: 'web' | 'worker' | 'both'
  failFirstAttempt?: string
  /**
   * Shares an existing log file instead of creating a new one — the two-worker
   * scenario in cron.test.ts passes the FIRST process's `logPath` to the
   * second so both processes' runs land in the one log a caller reads back,
   * matching the same "same log so the second process appends to the first's
   * records" convention `spawnApp`/shutdown.test.ts already establish for the
   * SIGKILL-recovery scenario.
   */
  logPath?: string
}

export interface CronAppHandle extends AppHandle {
  /** Every concierge-owned scheduler BullMQ currently reports for `queue`. */
  listSchedulers: (queue: string) => Promise<SchedulerSummary[]>
  /**
   * Writes a scheduler directly into Redis, bypassing this app's own
   * reconciliation entirely — simulating either a stale concierge-owned
   * scheduler left behind by a job that was since deleted from source, or a
   * foreign BullMQ repeatable job some other system installed on the same
   * queue.
   */
  injectOrphanScheduler: (queue: string, id: string) => Promise<void>
  /**
   * Kills the current process and boots a fresh one with the same start
   * options, so a caller can observe what boot-time reconciliation does on a
   * SECOND boot. Deliberately picks a new random port rather than reusing the
   * old one — the OS does not always release a killed process's port
   * instantly, and the two-process bullmq-recovery scenario in
   * shutdown.test.ts made the same call for the same reason.
   */
  restart: () => Promise<void>
  /**
   * Waits until `jobName`'s log carries `ticks` distinct `ctx.cron.tick`
   * values, then returns the total number of RUNS logged (not the number of
   * distinct ticks) — the figure the "bounded runs per tick" assertion needs.
   */
  countRunsOverTicks: (jobName: string, ticks: number, timeoutMs?: number) => Promise<number>
  /**
   * Waits until `opts.attempts` runs of `jobName` have been logged, in order,
   * and returns their `ctx.cron.tick` values in the order logged.
   */
  collectTicks: (jobName: string, opts: { attempts: number, timeoutMs?: number }) => Promise<number[]>
}

/**
 * A richer `spawnApp` for cron scenarios: bullmq-only (the memory driver
 * cannot run role `worker` at all, and its scheduling is single-process by
 * construction, so it cannot exercise "two processes, one Redis" in the first
 * place), and returns a handle carrying scheduler-introspection and
 * retry-observing methods alongside the base process controls.
 */
export const startApp = async (opts: StartAppOptions = {}): Promise<CronAppHandle> => {
  const logPath = opts.logPath ?? join(tmpdir(), `concierge-cron-${randomUUID()}.log`)
  // Only create/truncate when the caller did not supply an existing path —
  // truncating a shared logPath here would wipe out whatever the first
  // process already wrote before the second one started.
  if (!opts.logPath) writeFileSync(logPath, '')

  // Named distinctly from the top-of-file `spawn` import (node:child_process)
  // this whole harness otherwise uses, so nothing here shadows it.
  const launch = () => spawnApp({
    role: opts.role ?? 'worker',
    driver: 'bullmq',
    logPath,
    failFirstAttempt: opts.failFirstAttempt,
    // The one caller that WANTS the playground's schedules live. Every other
    // scenario leaves them off, so the digest cannot append to a log it is
    // not part of — see SpawnOptions.cronEnabled.
    cronEnabled: true,
  })

  let inner = await launch()
  await waitForReady(inner)

  const handle: CronAppHandle = {
    get proc() { return inner.proc },
    get port() { return inner.port },
    logPath,
    stop: () => inner.stop(),
    getStdout: () => inner.getStdout(),
    getStderr: () => inner.getStderr(),

    listSchedulers: async (queue) => withQueue(queue, async (q) => {
      const found = await q.getJobSchedulers()
      return found.map(j => ({ id: j.key, jobName: j.name }))
    }),

    injectOrphanScheduler: async (queue, id) => withQueue(queue, async (q) => {
      // Far in the future (once a year) so it is never a candidate to
      // actually fire during a test's own lifetime — these scenarios only
      // assert on the schedulers LIST, never on a job this orphan produces.
      await q.upsertJobScheduler(id, { pattern: '0 0 1 1 *', tz: 'UTC' }, { name: 'orphan-job', data: {} })
    }),

    restart: async () => {
      inner.stop()
      await waitForExit(inner, 20_000)
      inner = await launch()
      await waitForReady(inner)
    },

    countRunsOverTicks: async (jobName, ticks, timeoutMs = 190_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const lines = readHeartbeatLog(handle).filter(l => l.name === jobName)
        if (new Set(lines.map(l => l.tick)).size >= ticks) return lines.length
        await new Promise(r => setTimeout(r, 250))
      }
      throw new Error(`did not observe ${ticks} distinct ticks for "${jobName}" within ${timeoutMs}ms`)
    },

    collectTicks: async (jobName, { attempts, timeoutMs = 90_000 }) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const lines = readHeartbeatLog(handle).filter(l => l.name === jobName)
        if (lines.length >= attempts) return lines.slice(0, attempts).map(l => l.tick!)
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error(`did not observe ${attempts} attempt(s) for "${jobName}" within ${timeoutMs}ms`)
    },
  }

  return handle
}

/** Stops the process and removes its log file, matching `cleanup` above. */
export const stopApp = (app: CronAppHandle): void => cleanup(app)
