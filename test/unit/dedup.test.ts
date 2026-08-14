import { describe, expect, it } from 'vitest'
import { defaultDedupId, resolveDedup } from '../../src/runtime/server/dedup'

describe('defaultDedupId', () => {
  it('is stable for an equal payload', () => {
    expect(defaultDedupId('mail', { a: 1, b: 2 })).toBe(defaultDedupId('mail', { a: 1, b: 2 }))
  })

  it('differs for a different payload', () => {
    // Paired with the case above deliberately: a function returning a constant
    // satisfies "stable for an equal payload" perfectly.
    expect(defaultDedupId('mail', { a: 1 })).not.toBe(defaultDedupId('mail', { a: 2 }))
  })

  it('includes the job name, so two jobs with equal payloads do not collide', () => {
    expect(defaultDedupId('mail', { id: 1 })).not.toBe(defaultDedupId('report', { id: 1 }))
  })

  it('IS sensitive to object key order — an accepted, deliberate property', () => {
    // Not a bug and not an oversight. The order-insensitive canonical form this
    // replaced was attempted three times and abandoned; see the spec's "The
    // dedup key" section. This test exists so the property cannot be silently
    // "fixed" back into the design that failed. A caller who needs
    // order-insensitivity supplies `uniqueId`.
    expect(defaultDedupId('mail', { a: 1, b: 2 })).not.toBe(defaultDedupId('mail', { b: 2, a: 1 }))
  })

  it('distinguishes a value from its string form', () => {
    expect(defaultDedupId('j', { a: 1 })).not.toBe(defaultDedupId('j', { a: '1' }))
  })

  it('distinguishes null from undefined', () => {
    expect(defaultDedupId('j', { a: null })).not.toBe(defaultDedupId('j', { a: undefined }))
  })

  it('distinguishes two different Dates', () => {
    const d = new Date('2026-08-14T00:00:00.000Z')
    expect(defaultDedupId('j', d)).toBe(defaultDedupId('j', new Date(d.getTime())))
    expect(defaultDedupId('j', d)).not.toBe(defaultDedupId('j', new Date(d.getTime() + 1)))
  })

  it('distinguishes two different RegExps', () => {
    expect(defaultDedupId('j', /abc/)).not.toBe(defaultDedupId('j', /xyz/))
    expect(defaultDedupId('j', /abc/g)).not.toBe(defaultDedupId('j', /abc/i))
  })

  it('distinguishes two different URLs', () => {
    expect(defaultDedupId('j', new URL('http://a.example.com')))
      .not.toBe(defaultDedupId('j', new URL('http://b.example.com')))
  })

  it('distinguishes a URL subclass carrying its own property, by href', () => {
    // THE regression that killed the canonical form. Under the sorted-entries
    // design both of these collapsed to one key — two different webhooks, one
    // silently suppressed. devalue serializes a URL subclass by href, so the
    // envelope distinguishes them for free.
    class Webhook extends URL {
      readonly retries: number
      constructor(url: string, retries: number) {
        super(url)
        this.retries = retries
      }
    }
    expect(defaultDedupId('j', new Webhook('http://a.example.com', 3)))
      .not.toBe(defaultDedupId('j', new Webhook('http://b.example.com', 3)))
  })

  it('distinguishes Map contents and Set members', () => {
    expect(defaultDedupId('j', new Map([['x', 1]]))).not.toBe(defaultDedupId('j', new Map([['x', 2]])))
    expect(defaultDedupId('j', new Set([1]))).not.toBe(defaultDedupId('j', new Set([2])))
  })

  it('preserves array order, which is semantic', () => {
    expect(defaultDedupId('j', [1, 2])).not.toBe(defaultDedupId('j', [2, 1]))
  })

  it('is stable for a cron job with no payload', () => {
    expect(defaultDedupId('digest', undefined)).toBe(defaultDedupId('digest', undefined))
  })
})

describe('resolveDedup', () => {
  it('returns undefined when the job declares no uniqueness', () => {
    expect(resolveDedup({ jobName: 'mail', payload: {} })).toBeUndefined()
  })

  it('lock mode carries an id and no ttl', () => {
    expect(resolveDedup({ jobName: 'mail', payload: { a: 1 }, unique: {} }))
      .toEqual({ id: expect.any(String) })
  })

  it('throttle mode carries the ttl and neither extend nor replace', () => {
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: 60_000 } }))
      .toEqual({ id: expect.any(String), ttl: 60_000 })
  })

  it('debounce mode sets extend and replace alongside the ttl', () => {
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: 5_000, debounce: true } }))
      .toEqual({ id: expect.any(String), ttl: 5_000, extend: true, replace: true })
  })

  it('ignores debounce without a ttl', () => {
    // `extend`/`replace` with no expiry is BullMQ's replace-with-no-expiry
    // branch — a lock that keeps moving, not a debounce window. `defineJob`
    // rejects this combination at definition time (Task 4), so this asserts the
    // resolver degrades safely rather than emitting a mode nobody asked for.
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { debounce: true } }))
      .toEqual({ id: expect.any(String) })
  })

  it('prefers a user-supplied uniqueId over the default', () => {
    expect(resolveDedup({
      jobName: 'mail',
      payload: { id: 7 },
      unique: {},
      uniqueId: (p: { id: number }) => `invoice:${p.id}`,
    })?.id).toBe('mail:invoice:7')
  })

  it('namespaces a user-supplied uniqueId by job name', () => {
    // Two jobs whose uniqueId functions both return "1" must not collide — a
    // cross-job interaction nobody could predict from reading either job.
    const a = resolveDedup({ jobName: 'mail', payload: {}, unique: {}, uniqueId: () => '1' })
    const b = resolveDedup({ jobName: 'report', payload: {}, unique: {}, uniqueId: () => '1' })
    expect(a?.id).not.toBe(b?.id)
  })
})
