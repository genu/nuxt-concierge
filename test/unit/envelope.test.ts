import { describe, it, expect } from 'vitest'
import { encodePayload, decodePayload, UnsupportedEnvelopeError } from '../../src/runtime/server/envelope'

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

  it('produces a JSON-serialisable envelope so BullMQ can store it', () => {
    const envelope = encodePayload({ at: new Date() })
    expect(() => JSON.parse(JSON.stringify(envelope))).not.toThrow()
  })

  it('throws a non-retryable error on an unknown envelope version', () => {
    const err = (() => {
      try {
        decodePayload({ v: 99, payload: '[]' })
        return null
      }
      catch (e) {
        return e as UnsupportedEnvelopeError
      }
    })()

    expect(err).toBeInstanceOf(UnsupportedEnvelopeError)
    expect(err!.retryable).toBe(false)
    expect(err!.message).toMatch(/envelope version 99/)
  })

  it('throws on a malformed envelope rather than returning undefined', () => {
    expect(() => decodePayload({ nope: true })).toThrow(UnsupportedEnvelopeError)
    expect(() => decodePayload(null)).toThrow(UnsupportedEnvelopeError)
  })
})
