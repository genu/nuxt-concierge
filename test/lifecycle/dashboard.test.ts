import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnDevApp, waitForReady, readLog, waitForLogCount, cleanup, killAllSpawned, type AppHandle } from './harness'

/**
 * The ONLY end-to-end coverage of the dashboard, and necessarily against a dev
 * server: registration is gated on nuxt.options.dev, so the built output the
 * rest of this suite uses contains no dashboard at all.
 *
 * Also the experiment for the spec's public-assets question: if `/_concierge/ui/`
 * did not resolve index.html, or if the asset middleware swallowed
 * `/_concierge/api/*` or `/_concierge/health`, the first three cases here fail.
 */
describe('the dev dashboard', () => {
  let app: AppHandle

  beforeAll(async () => {
    app = await spawnDevApp({ driver: 'memory' })
    // Generous: Vite compiles the app on first request, which is far slower
    // than booting the prebuilt output the rest of this suite spawns.
    await waitForReady(app, 120_000)
  }, 180_000)

  afterAll(() => {
    if (app) cleanup(app)
    killAllSpawned()
  })

  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`)
    return { status: res.status, body: await res.text() }
  }

  it('serves the SPA shell at /_concierge/ui/', async () => {
    // NOT /_concierge/: an earlier task moved the SPA's static assets one
    // path segment deeper after confirming Nitro's public-asset middleware
    // shadows sibling server routes registered under the same baseURL rather
    // than falling through to them.
    const res = await get('/_concierge/ui/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('<div id="app">')
  })

  it('serves the API alongside the static assets without either shadowing the other', async () => {
    const res = await get('/_concierge/api/overview')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { driver: string, introspectable: boolean }
    // The discriminating pair: HTML here would mean the public-asset
    // middleware swallowed the API route, which is the exact silent
    // mis-resolution the spec flagged as presenting like an empty panel.
    expect(body.driver).toBe('memory')
    expect(body.introspectable).toBe(true)
  })

  it('still serves /_concierge/health in dev, unshadowed by the /_concierge/ui asset registration', async () => {
    // The exact regression the /_concierge/ui move fixed: registering the
    // SPA's assets at the bare /_concierge baseURL made this 404. Only
    // unit-level coverage exists for that registration decision; this is the
    // end-to-end check against a real running dev server.
    const res = await get('/_concierge/health')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { state?: string }
    expect(body.state).toBe('running')
  })

  it('shows a failed job, retries it, and the job runs again', async () => {
    // `failing.ts` is configured with attempts: 3 and a 100ms fixed backoff.
    // failUntilAttempt: 99 fails every one of those three attempts, landing
    // the job terminally in `failed`.
    await fetch(`http://127.0.0.1:${app.port}/api/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job: 'failing', count: 1, payload: { seq: 0, failUntilAttempt: 99 } }),
    })

    const listUrl = '/_concierge/api/queues/default/jobs?state=failed'
    let failed: { items: Array<{ id: string, failedReason?: string }> } = { items: [] }
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && failed.items.length === 0) {
      failed = JSON.parse((await get(listUrl)).body)
      if (!failed.items.length) await new Promise(r => setTimeout(r, 250))
    }

    expect(failed.items.length).toBeGreaterThan(0)
    const id = failed.items[0]!.id

    const detail = JSON.parse((await get(`/_concierge/api/queues/default/jobs/${id}`)).body) as {
      payload: { ok: boolean, value?: { failUntilAttempt: number } }
    }
    // Decoded server-side, so the SPA never sees a devalue string — and the
    // decoded value itself is the payload this test actually enqueued, not
    // just "something decoded".
    expect(detail.payload.ok).toBe(true)
    expect(detail.payload.value?.failUntilAttempt).toBe(99)

    // The count BEFORE the retry, read from the append-only log rather than
    // from the failed-list membership: `failing` appends one line per
    // attempt, and after a retry the job re-fails and lands back in `failed`
    // within roughly 200-300ms (three attempts at a 100ms fixed backoff) —
    // comfortably faster than a poll interval tuned to be non-flaky, which
    // is exactly why "the job left the failed list" is not asserted here.
    // The log is append-only and monotonic, so it cannot race the same way.
    const beforeCount = readLog(app).length

    const retried = await fetch(
      `http://127.0.0.1:${app.port}/_concierge/api/queues/default/jobs/${id}/retry`,
      { method: 'POST' },
    )
    expect(retried.status).toBe(204)

    // Proves the retry actually re-ran the job, not just that the endpoint
    // returned 204: a retry route that did nothing at all would leave the
    // log unchanged forever, and this would time out rather than pass.
    await waitForLogCount(app, beforeCount + 1, 30_000)
  }, 90_000)
})
