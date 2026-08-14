import { describe, it, expect } from 'vitest'
import {
  toDetailResponse,
  decodeForDisplay,
  readJobsList,
  readJobDetail,
  retryJob,
  DriverReadTimeoutError,
} from '../../../src/runtime/server/introspect'
import { encodePayload } from '../../../src/runtime/server/envelope'
import type { DriverIntrospection } from '../../../src/runtime/server/drivers/types'

/**
 * Simulates ioredis's offline command queue against a dead connection
 * (`maxRetriesPerRequest: null`): the promise never settles at all, rather
 * than resolving or rejecting late. Only the function under test's own
 * timeout is allowed to move past this — matching the `hangOnRead` fixture in
 * `test/unit/api/overview.test.ts`.
 */
const hangingIntrospect: DriverIntrospection = {
  counts: () => new Promise(() => {}),
  list: () => new Promise(() => {}),
  get: () => new Promise(() => {}),
  retry: () => new Promise(() => {}),
}

describe('decodeForDisplay', () => {
  it('decodes a valid envelope', () => {
    const result = decodeForDisplay(encodePayload({ hello: 'world' }))
    expect(result).toEqual({ ok: true, value: { hello: 'world' } })
  })

  it('reports a failure for an unrecognised envelope version', () => {
    const result = decodeForDisplay({ v: 99, payload: '[]' })

    // BOTH branches are asserted across these two cases. A failure-only test
    // passes against an implementation that never succeeds, and a success-only
    // test passes against one that never catches.
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('version 99')
  })

  it('does not echo payload content in the failure message', () => {
    const result = decodeForDisplay({ v: 1, payload: 'not-devalue-at-all' })

    expect(result.ok).toBe(false)
    // The message describes SHAPE only. A payload routinely carries user data,
    // and this string reaches the UI, the log stream and (via the driver's
    // UnrecoverableError) the queue backend.
    expect(result.ok === false && result.error).not.toContain('not-devalue-at-all')
  })
})

describe('toDetailResponse', () => {
  const detail = {
    id: '1',
    name: 'send-email',
    queue: 'mail',
    state: 'failed' as const,
    attemptsMade: 1,
    createdAt: 1000,
    envelope: encodePayload({ to: 'a@b.c' }),
    failedReason: 'smtp down',
  }

  it('replaces the envelope with a decoded payload result', () => {
    const response = toDetailResponse(detail)

    expect(response.payload).toEqual({ ok: true, value: { to: 'a@b.c' } })
    // The raw envelope must NOT survive into the response: it would put the
    // devalue string in front of the user and give the client a second,
    // undecoded copy of the payload to be tempted into parsing itself.
    expect(response).not.toHaveProperty('envelope')
  })

  it('preserves the summary fields alongside the decoded payload', () => {
    const response = toDetailResponse(detail)
    expect(response.id).toBe('1')
    expect(response.failedReason).toBe('smtp down')
    expect(response.attemptsMade).toBe(1)
  })

  it('surfaces a decode failure rather than dropping the job', () => {
    const response = toDetailResponse({ ...detail, envelope: { v: 42, payload: '[]' } })

    // The job is still returned — its id, state and failure reason are exactly
    // what you need when the payload is the thing that is broken.
    expect(response.id).toBe('1')
    expect(response.payload.ok).toBe(false)
  })
})

/**
 * The Jobs tab has the identical unbounded-hang exposure `buildOverview` had,
 * over the same three routes (list/detail/retry) — a dead-Redis bullmq
 * connection queues `introspect.list()`/`get()`/`retry()` forever. Each of
 * these three, unlike `buildOverview`, is a single-resource read with a real
 * HTTP status to pick, so a timeout here THROWS (`DriverReadTimeoutError`)
 * rather than degrading to a sentinel — the route handler turns that into a
 * 503 naming the driver, instead of letting `JobsPanel` render an empty list
 * indistinguishable from "there are genuinely no jobs" (its only other
 * signal, `overview.introspectable`, stays `true` for bullmq throughout an
 * outage).
 *
 * Every test below uses a real `Promise.race` against a promise that never
 * settles, with a short INJECTED timeout (not the production 1.5s constant,
 * and not fake timers) — so each test's own wall-clock cost is bounded by
 * that number.
 */
describe('the jobs list/detail/retry routes time out instead of hanging', () => {
  it('readJobsList rejects with DriverReadTimeoutError instead of hanging forever', async () => {
    await expect(
      readJobsList(hangingIntrospect, 'bullmq', 'default', 'failed', { offset: 0, limit: 25 }, 20),
    ).rejects.toThrow(DriverReadTimeoutError)
  })

  it('readJobsList names the driver and the bound in the timeout message', async () => {
    await expect(
      readJobsList(hangingIntrospect, 'bullmq', 'default', 'failed', { offset: 0, limit: 25 }, 20),
    ).rejects.toThrow(/bullmq driver did not respond within 20ms/)
  })

  it('readJobDetail rejects with DriverReadTimeoutError instead of hanging forever', async () => {
    // Also the case that rules out a sentinel-return design: `get()`'s own
    // legitimate "no such job" answer IS `undefined`, so a timeout that also
    // resolved to `undefined` would be indistinguishable from a 404 — this
    // must reject, not resolve.
    await expect(
      readJobDetail(hangingIntrospect, 'bullmq', 'default', 'mem-1', 20),
    ).rejects.toThrow(DriverReadTimeoutError)
  })

  it('retryJob rejects with DriverReadTimeoutError instead of hanging forever', async () => {
    await expect(
      retryJob(hangingIntrospect, 'bullmq', 'default', 'mem-1', 20),
    ).rejects.toThrow(DriverReadTimeoutError)
  })
})
