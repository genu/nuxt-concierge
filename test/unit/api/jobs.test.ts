import { describe, it, expect } from 'vitest'
import { toDetailResponse, decodeForDisplay } from '../../../src/runtime/server/introspect'
import { encodePayload } from '../../../src/runtime/server/envelope'

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
