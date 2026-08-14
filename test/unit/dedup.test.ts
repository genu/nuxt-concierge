import { describe, expect, it } from 'vitest'
import { canonicalize, defaultDedupId, resolveDedup } from '../../src/runtime/server/dedup'

describe('canonicalize', () => {
  it('is insensitive to object key insertion order', () => {
    // THE case this module exists for. Object key order is insertion-ordered
    // in JS and devalue preserves it, so two call sites building the same
    // logical payload in different orders would otherwise dedup inconsistently
    // — a bug that passes every end-to-end test written by one author.
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }))
  })

  it('still distinguishes genuinely different payloads', () => {
    // Paired with the case above deliberately: an implementation returning a
    // constant satisfies "insensitive to key order" perfectly.
    expect(canonicalize({ a: 1, b: 2 })).not.toBe(canonicalize({ a: 1, b: 3 }))
  })

  it('distinguishes a value from its string form', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }))
  })

  it('encodes Date by instant', () => {
    const d = new Date('2026-08-14T00:00:00.000Z')
    expect(canonicalize(d)).toBe(canonicalize(new Date(d.getTime())))
    expect(canonicalize(d)).not.toBe(canonicalize(new Date(d.getTime() + 1)))
  })

  it('encodes Map by sorted entries, not insertion order', () => {
    const a = new Map([['x', 1], ['y', 2]])
    const b = new Map([['y', 2], ['x', 1]])
    expect(canonicalize(a)).toBe(canonicalize(b))
  })

  it('encodes Set by sorted members, not insertion order', () => {
    expect(canonicalize(new Set([1, 2]))).toBe(canonicalize(new Set([2, 1])))
  })

  it('preserves array order, which is semantic', () => {
    // Arrays are NOT sorted: [1,2] and [2,1] are different payloads.
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]))
  })

  it('distinguishes an absent key from an explicit undefined', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 1, b: undefined }))
  })

  it('distinguishes null from undefined', () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({ a: undefined }))
  })

  it('distinguishes two different regular expressions', () => {
    expect(canonicalize(/abc/)).not.toBe(canonicalize(/xyz/))
  })

  it('distinguishes regexp flags', () => {
    expect(canonicalize(/abc/g)).not.toBe(canonicalize(/abc/i))
  })

  it('distinguishes a regexp from an empty plain object', () => {
    // `Object.entries(/abc/)` is `[]`, so without an explicit branch every
    // regex canonicalizes identically to `{}`.
    expect(canonicalize(/abc/)).not.toBe(canonicalize({}))
  })

  it('still treats two equal regexps as equal', () => {
    // Paired with the three negatives above: an encoding that returned a fresh
    // unique string per call would satisfy all of them and be useless.
    expect(canonicalize(/abc/g)).toBe(canonicalize(/abc/g))
  })

  it('distinguishes a typed array from a plain object with the same entries', () => {
    expect(canonicalize(new Uint8Array([1, 2, 3]))).not.toBe(canonicalize({ 0: 1, 1: 2, 2: 3 }))
  })

  it('distinguishes a class instance from a plain object with the same entries', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    // Both have own enumerable `{ x: 1 }` and both brand as [object Object];
    // only the plain-prototype check separates them.
    expect(canonicalize(new Point(1))).not.toBe(canonicalize({ x: 1 }))
  })

  it('treats a null-prototype object as plain', () => {
    // Object.create(null) is a plain bag of data, not an exotic type — the
    // brand branch must not catch it, or a payload built with a null-prototype
    // object would never dedup against its literal equivalent.
    const bare = Object.create(null) as Record<string, unknown>
    bare.a = 1
    expect(canonicalize(bare)).toBe(canonicalize({ a: 1 }))
  })
})

describe('defaultDedupId', () => {
  it('includes the job name, so two jobs with equal payloads do not collide', () => {
    expect(defaultDedupId('mail', { id: 1 })).not.toBe(defaultDedupId('report', { id: 1 }))
  })

  it('is stable for the same job and logical payload', () => {
    expect(defaultDedupId('mail', { a: 1, b: 2 })).toBe(defaultDedupId('mail', { b: 2, a: 1 }))
  })
})

describe('resolveDedup', () => {
  it('returns undefined when the job declares no uniqueness', () => {
    expect(resolveDedup({ jobName: 'mail', payload: {} })).toBeUndefined()
  })

  it('lock mode carries an id and no ttl', () => {
    const d = resolveDedup({ jobName: 'mail', payload: { a: 1 }, unique: {} })
    expect(d).toEqual({ id: expect.any(String) })
  })

  it('throttle mode carries the ttl and neither extend nor replace', () => {
    const d = resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: 60_000 } })
    expect(d).toEqual({ id: expect.any(String), ttl: 60_000 })
  })

  it('debounce mode sets extend and replace alongside the ttl', () => {
    const d = resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: 5_000, debounce: true } })
    expect(d).toEqual({ id: expect.any(String), ttl: 5_000, extend: true, replace: true })
  })

  it('prefers a user-supplied uniqueId over the default', () => {
    const d = resolveDedup({
      jobName: 'mail',
      payload: { id: 7 },
      unique: {},
      uniqueId: (p: { id: number }) => `invoice:${p.id}`,
    })
    expect(d?.id).toBe('mail:invoice:7')
  })

  it('namespaces a user-supplied uniqueId by job name', () => {
    // Two jobs whose uniqueId functions both return "1" must not collide.
    const a = resolveDedup({ jobName: 'mail', payload: {}, unique: {}, uniqueId: () => '1' })
    const b = resolveDedup({ jobName: 'report', payload: {}, unique: {}, uniqueId: () => '1' })
    expect(a?.id).not.toBe(b?.id)
  })
})
