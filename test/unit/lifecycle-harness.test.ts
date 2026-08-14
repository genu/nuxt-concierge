import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { namespaceRedisUrl, readLog, type AppHandle } from '../lifecycle/harness'

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
