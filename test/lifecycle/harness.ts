import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import IORedis from 'ioredis'

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

const killAll = () => {
  for (const proc of spawned) {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
  spawned.clear()
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
 * Points lifecycle tests at a dedicated Redis logical database rather than
 * whatever database the supplied REDIS_URL defaults to (0). `flushRedis`
 * below runs `FLUSHDB`, which would otherwise wipe an operator's real data
 * on a shared, non-ephemeral Redis. Call this once, before anything reads
 * REDIS_URL to build or spawn — the URL is rewritten in place so every
 * consumer (the build, `flushRedis`, and every spawned app, since the
 * connection URL is threaded through unchanged) agrees on the same
 * isolated database.
 */
export const namespaceRedisUrl = (url: string, db = 15): string => `${url.replace(/\/\d+$/, '')}/${db}`

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
 * (see `namespaceRedisUrl`), never the operator's default database.
 */
export const flushRedis = async (): Promise<void> => {
  const url = process.env.REDIS_URL
  if (!url) return

  const client = new IORedis(url, { maxRetriesPerRequest: 0, lazyConnect: true })
  try {
    await client.connect()
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

export const readLog = (app: AppHandle): LogLine[] =>
  readFileSync(app.logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as LogLine)

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
  for (const l of lines) counts.set(l.jobId, (counts.get(l.jobId) ?? 0) + 1)
  return {
    completed: new Set(counts.keys()),
    duplicates: [...counts.entries()].filter(([, n]) => n > 1).length,
    pids: new Set(lines.map(l => l.pid)),
  }
}
