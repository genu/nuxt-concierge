import { describe, it, expect } from 'vitest'
import { encodePayload, decodePayload, UnsupportedEnvelopeError } from '../../src/runtime/server/envelope'

const expectNonRetryable = (fn: () => unknown) => {
  // Unconditional: fails if fn does not throw at all.
  expect(fn).toThrow(UnsupportedEnvelopeError)

  const error = (() => {
    try { fn(); return undefined }
    catch (e) { return e }
  })()

  expect(error).toBeInstanceOf(UnsupportedEnvelopeError)
  expect((error as UnsupportedEnvelopeError).retryable).toBe(false)
}

describe('payload envelope', () => {
  it('round-trips plain objects', () => {
    const payload = { to: 'a@b.com', count: 3 }
    expect(decodePayload(encodePayload(payload))).toEqual(payload)
  })

  it('preserves Date, which JSON silently mangles', () => {
    const at = new Date('2026-08-12T10:00:00.000Z')
    const out = decodePayload(encodePayload({ at })) as { at: Date }
    expect(out.at).toBeInstanceOf(Date)
    expect(out.at.toISOString()).toBe(at.toISOString())
  })

  it('preserves Map, Set and undefined', () => {
    const payload = {
      map: new Map([['k', 1]]),
      set: new Set([1, 2]),
      nothing: undefined,
    }
    const out = decodePayload(encodePayload(payload)) as typeof payload
    expect(out.map).toBeInstanceOf(Map)
    expect(out.map.get('k')).toBe(1)
    expect(out.set).toBeInstanceOf(Set)
    expect(out.set.has(2)).toBe(true)
    expect('nothing' in out).toBe(true)
    expect(out.nothing).toBeUndefined()
  })

  it('stamps the envelope version', () => {
    expect(encodePayload({}).v).toBe(1)
  })

  it('survives JSON serialization round-trip for BullMQ storage', () => {
    const originalPayload = { at: new Date('2026-08-12T10:00:00.000Z'), count: 42 }
    const envelope = encodePayload(originalPayload)
    const roundTripped = JSON.parse(JSON.stringify(envelope)) as unknown

    // Envelope structure survives round-trip
    expect(roundTripped).toEqual(envelope)

    // Payload can be decoded from the round-tripped envelope and recovers original data
    const decodedPayload = decodePayload(roundTripped) as { at: Date; count: number }
    expect(decodedPayload.count).toBe(42)
    expect(decodedPayload.at).toBeInstanceOf(Date)
    expect(decodedPayload.at.toISOString()).toBe(originalPayload.at.toISOString())
  })

  it('throws a non-retryable error on an unknown envelope version', () => {
    expectNonRetryable(() => decodePayload({ v: 99, payload: '[]' }))

    // Also verify the error message mentions the version mismatch
    const err = (() => {
      try {
        decodePayload({ v: 99, payload: '[]' })
        return null
      }
      catch (e) {
        return e as UnsupportedEnvelopeError
      }
    })()
    expect(err!.message).toMatch(/envelope version 99/)
  })

  it('throws on a malformed envelope rather than returning undefined', () => {
    expectNonRetryable(() => decodePayload({ nope: true }))
    expectNonRetryable(() => decodePayload(null as unknown))
  })

  it('throws non-retryable error when v is not a number', () => {
    expectNonRetryable(() => decodePayload({ v: '1', payload: '[]' }))
  })

  it('throws non-retryable error when payload is not a string', () => {
    expectNonRetryable(() => decodePayload({ v: 1, payload: 42 }))
  })

  it('throws non-retryable error when payload is valid JSON but not valid devalue', () => {
    expectNonRetryable(() => decodePayload({ v: 1, payload: '{"a":1}' }))
  })
})
