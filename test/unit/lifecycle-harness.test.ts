import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import {
  namespaceRedisUrl, readLog, waitForActiveCount, waitForExit, waitForReady,
  type AppHandle,
} from '../lifecycle/harness'

describe('the lifecycle suite builds the playground exactly once', () => {
  it('has no per-file build in any lifecycle test', () => {
    const dir = resolve(import.meta.dirname, '../lifecycle')
    const files = ['retry.test.ts', 'shutdown.test.ts', 'dashboard.test.ts']

    for (const file of files) {
      let source: string
      try { source = readFileSync(resolve(dir, file), 'utf8') }
      catch { continue }

      // The build belongs in globalSetup. A per-file build is invisible in a
      // green run — it only shows up as wall-clock time, which is exactly why
      // it grew to two copies before anyone noticed.
      expect(source, `${file} must not build the playground itself`).not.toMatch(/dev:build/)
    }
  })
})

describe('namespaceRedisUrl', () => {
  it('rewrites a plain URL with no path at all', () => {
    expect(namespaceRedisUrl('redis://host:6379')).toBe('redis://host:6379/15')
  })

  it('rewrites a URL with only a trailing slash instead of appending a second one', () => {
    // A regex matching only a trailing `/\d+` cannot match here (there is no
    // digit to replace), so a naive implementation appends instead of
    // replacing: `redis://host:6379//15`. That extra empty path segment is
    // not a valid database selector, and ioredis silently falls back to
    // database 0.
    expect(namespaceRedisUrl('redis://host:6379/')).toBe('redis://host:6379/15')
  })

  it('rewrites a URL with query params instead of appending after them', () => {
    // A regex anchored on a trailing `/\d+` does not match a path-less URL
    // with a query string either, so it appends: `...?family=6/15`, which
    // is part of the query string, not a database selector at all.
    expect(namespaceRedisUrl('redis://host:6379?family=6')).toBe('redis://host:6379/15?family=6')
  })

  it('replaces an existing numeric database segment rather than appending another', () => {
    expect(namespaceRedisUrl('redis://host:6379/3')).toBe('redis://host:6379/15')
  })

  it('preserves auth credentials', () => {
    expect(namespaceRedisUrl('redis://user:pass@host:6379')).toBe('redis://user:pass@host:6379/15')
  })

  it('accepts a custom database number', () => {
    expect(namespaceRedisUrl('redis://host:6379', 7)).toBe('redis://host:6379/7')
  })

  it('throws rather than silently proceeding on a URL that cannot be parsed', () => {
    expect(() => namespaceRedisUrl('not a url at all')).toThrow()
  })
})

describe('readLog', () => {
  const tempApp = (content: string): AppHandle => {
    const logPath = join(tmpdir(), `concierge-readlog-${randomUUID()}.log`)
    writeFileSync(logPath, content)
    return { logPath } as AppHandle
  }

  it('parses well-formed lines', () => {
    const app = tempApp(
      `${JSON.stringify({ jobId: 0, attempt: 1, pid: 1, id: 'a' })}\n`
      + `${JSON.stringify({ jobId: 1, attempt: 1, pid: 1, id: 'b' })}\n`,
    )

    expect(readLog(app)).toEqual([
      { jobId: 0, attempt: 1, pid: 1, id: 'a' },
      { jobId: 1, attempt: 1, pid: 1, id: 'b' },
    ])

    rmSync(app.logPath)
  })

  it('tolerates a single torn TRAILING line, the SIGKILL-recovery artifact this exists for', () => {
    // SIGKILL can interrupt appendFileSync mid-write, leaving a partial JSON
    // line as the file's last line. That is an expected artifact of a
    // scenario that kills processes deliberately, not a bug — a confusing
    // SyntaxError here would mask the scenario's real assertion.
    const complete = JSON.stringify({ jobId: 0, attempt: 1, pid: 1, id: 'a' })
    const app = tempApp(`${complete}\n{"jobId": 1, "attempt": 1, "pid": 1, "i`)

    expect(readLog(app)).toEqual([{ jobId: 0, attempt: 1, pid: 1, id: 'a' }])

    rmSync(app.logPath)
  })

  it('still throws on a malformed line that is NOT the last one', () => {
    // Tolerance is scoped to the specific SIGKILL-recovery shape (a torn
    // trailing line) — a malformed line anywhere else is a real bug in the
    // job or the harness and must not be silently dropped.
    const complete = JSON.stringify({ jobId: 1, attempt: 1, pid: 1, id: 'b' })
    const app = tempApp(`{"broken\n${complete}\n`)

    expect(() => readLog(app)).toThrow()

    rmSync(app.logPath)
  })
})

describe('the waits report an early exit with enough evidence to diagnose it', () => {
  /**
   * A handle whose process is already gone. Every wait below checks liveness
   * BEFORE its first fetch, so nothing here touches the network and `port`
   * never has to be real.
   */
  const deadApp = (proc: Partial<ChildProcess>, stdout = '', stderr = ''): AppHandle => ({
    proc: { exitCode: null, signalCode: null, ...proc } as ChildProcess,
    port: 1,
    logPath: '',
    stop: () => {},
    getStdout: () => stdout,
    getStderr: () => stderr,
  })

  it('attaches the child stdout and stderr, which die with the process otherwise', async () => {
    // The whole reason issue #23 could not be resolved from its one
    // observation: the error was a bare exit code, and by the time anyone read
    // it the process that could have explained it was gone.
    const app = deadApp(
      { exitCode: 0 },
      'Listening on http://[::]:3901\n[nuxt-concierge] Workers drained cleanly',
      'some stderr line',
    )

    await expect(waitForActiveCount(app, 5)).rejects.toThrow(/Workers drained cleanly/)
    await expect(waitForActiveCount(app, 5)).rejects.toThrow(/some stderr line/)
  })

  it('names what it was waiting for, so the error is not ambiguous between the waits', async () => {
    const app = deadApp({ exitCode: 0 })

    await expect(waitForActiveCount(app, 5)).rejects.toThrow(/activeCount to reach 5/)
    await expect(waitForReady(app)).rejects.toThrow(/health endpoint to become ready/)
  })

  it('explains that code 0 specifically means "it was signalled"', async () => {
    // Not a generic "died" code: the only route to 0 in the built output is
    // the graceful-shutdown path, so 0 during a scenario that has not
    // signalled yet points at the signal's SOURCE, not at the drain.
    await expect(waitForActiveCount(deadApp({ exitCode: 0 }), 5))
      .rejects.toThrow(/GRACEFUL SHUTDOWN/)
  })

  it('does not claim a graceful shutdown for any other exit code', async () => {
    await expect(waitForActiveCount(deadApp({ exitCode: 1 }), 5))
      .rejects.not.toThrow(/GRACEFUL SHUTDOWN/)
  })

  it('resolves waitForExit for a process that already died by signal', async () => {
    // waitForExit is the one wait that resolves off an event rather than a
    // poll, so the signal blind spot bites differently there: `once('exit')`
    // registered after the event already fired never fires at all, and the
    // call hangs to its timeout reporting "process did not exit in time"
    // about a process that exited long ago. Asserting `once` was never reached
    // is what pins that — a resolved promise alone would not distinguish the
    // early return from a listener that happened to fire.
    const once = vi.fn()
    const app = deadApp({ exitCode: null, signalCode: 'SIGKILL', once: once as never })

    await expect(waitForExit(app, 5_000)).resolves.toBeNull()
    expect(once).not.toHaveBeenCalled()
  })

  it('fails immediately on a signal death instead of spinning out the full timeout', async () => {
    // Node reports a signalled process as `exitCode: null`, so a liveness
    // check that only looks at exitCode sees a DEAD process as alive. The
    // wait then runs to its deadline and reports "activeCount did not reach
    // N" — a timeout, for a process that crashed seconds earlier, which sends
    // the reader to the driver instead of to the crash.
    const app = deadApp({ exitCode: null, signalCode: 'SIGKILL' })

    const started = Date.now()
    await expect(waitForActiveCount(app, 5, 5_000)).rejects.toThrow(/exited early on signal SIGKILL/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('flushRedis', () => {
  const ORIGINAL_REDIS_URL = process.env.REDIS_URL

  afterEach(() => {
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL
    vi.doUnmock('ioredis')
    vi.resetModules()
  })

  it('is a no-op when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL
    const { flushRedis } = await import('../lifecycle/harness')

    // Should resolve without ever constructing a client.
    await expect(flushRedis()).resolves.toBeUndefined()
  })

  it('refuses to flush when the connection resolves to a database other than the namespaced one', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379/0'

    const flushdb = vi.fn(async () => {})
    const connect = vi.fn(async () => {})
    const disconnect = vi.fn()

    vi.doMock('ioredis', () => ({
      default: vi.fn().mockImplementation(function () {
        return { options: { db: 0 }, connect, flushdb, disconnect }
      }),
    }))

    const { flushRedis } = await import('../lifecycle/harness')

    await expect(flushRedis()).rejects.toThrow(/refusing to FLUSHDB/)
    // The whole point of the guard: flushdb() must never be reached.
    expect(flushdb).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
  })

  it('flushes when the connection resolves to the expected namespaced database', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379/15'

    const flushdb = vi.fn(async () => {})
    const connect = vi.fn(async () => {})
    const disconnect = vi.fn()

    vi.doMock('ioredis', () => ({
      default: vi.fn().mockImplementation(function () {
        return { options: { db: 15 }, connect, flushdb, disconnect }
      }),
    }))

    const { flushRedis } = await import('../lifecycle/harness')

    await expect(flushRedis()).resolves.toBeUndefined()
    expect(flushdb).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalled()
  })
})
