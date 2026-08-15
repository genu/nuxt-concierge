import { describe, expect, it } from 'vitest'
import { defaultDedupId, resolveDedup } from '../../src/runtime/server/dedup'
import { decodePayload, encodePayload } from '../../src/runtime/server/envelope'

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

  it('distinguishes a URL subclass by href', () => {
    // The plain-URL case above with a subclass in place of URL — devalue
    // brands on Object.prototype.toString, so a subclass serializes as its
    // parent type and the href still separates them. Under the abandoned
    // canonical form both of these collapsed to one key, because that design
    // encoded the subclass by its OWN properties and never saw the href.
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

  it('collapses a URL subclass differing only in its own property — and that is correct', () => {
    // devalue serializes a branded type by its brand's value and DROPS own
    // properties, so these two enqueues would deliver an identical payload to
    // the handler. Suppressing one is therefore not data loss; it is exactly
    // what deduplication is for.
    //
    // This is the whole closure argument in one case: every driver round-trips
    // the payload through the envelope before the handler sees it, so a key
    // collision implies byte-identical delivery. Asserting the delivered value
    // alongside the key is what makes that a demonstrated property rather than
    // a claim in a comment.
    class Webhook extends URL {
      readonly retries: number
      constructor(url: string, retries: number) {
        super(url)
        this.retries = retries
      }
    }
    const a = new Webhook('http://a.example.com', 3)
    const b = new Webhook('http://a.example.com', 9)

    expect(defaultDedupId('j', a)).toBe(defaultDedupId('j', b))
    expect(decodePayload(encodePayload(a))).toEqual(decodePayload(encodePayload(b)))
  })

  it('throws for a payload devalue cannot serialize', () => {
    // The docstring claims this throws no earlier than it would anyway, since
    // `driver.enqueue` calls `encodePayload` on the same value one step later.
    // Asserting the message shape matters too: this text can reach a log, and
    // the project's rule is that errors describe shape, never content.
    expect(() => defaultDedupId('j', { cb: () => {} })).toThrow(/Cannot stringify a function/)
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

  it('treats a zero or negative ttl as no ttl at all', () => {
    // `defineJob` rejects these, but a hand-built registry entry reaches
    // `resolveDedup` directly — and the two must agree on what counts as a
    // usable ttl. Emitting `{ ttl: 0, extend, replace }` would hand BullMQ the
    // replace-with-no-expiry branch: a lock that keeps moving.
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: 0, debounce: true } }))
      .toEqual({ id: expect.any(String) })
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: 0 } }))
      .toEqual({ id: expect.any(String) })
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: -5 } }))
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
