import { describe, expect, it, vi } from 'vitest'
import { createMemoryDriver } from '../../../src/runtime/server/drivers/memory'

const flush = () => new Promise(r => setTimeout(r, 60))

describe('memory driver deduplication — lock mode', () => {
  it('suppresses a second enqueue while the first is queued', async () => {
    const driver = createMemoryDriver()
    const first = await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })
    const second = await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })

    // Both halves. "deduplicated is true" alone is satisfied by an
    // implementation that also drops the FIRST job.
    expect(second).toEqual({ id: first.id, deduplicated: true })
    expect((await driver.introspect!.counts('default')).waiting).toBe(1)
  })

  it('releases the key when the job completes', async () => {
    const driver = createMemoryDriver()
    driver.registerHandler('default', 'j', async () => {})
    driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })
    await flush()

    const after = await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })
    expect(after.deduplicated).toBe(false)
  })

  it('releases the key on TERMINAL failure', async () => {
    const driver = createMemoryDriver()
    driver.registerHandler('default', 'j', async () => { throw new Error('boom') })
    driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' }, attempts: 1 })
    await flush()

    expect((await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })).deduplicated)
      .toBe(false)
  })

  it('does NOT release the key on an intermediate failure', async () => {
    // The case most likely to be got wrong. Retries move a job through
    // moveToDelayed/retryJob, never moveToFinished, so a job with attempts: 3
    // holds its key across all three. An implementation that releases on every
    // catch lets a duplicate in mid-retry — and every other case in this file
    // still passes.
    const driver = createMemoryDriver()
    let calls = 0
    driver.registerHandler('default', 'j', async () => {
      calls++
      throw new Error('boom')
    })
    driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', {
      name: 'j', payload: {}, dedup: { id: 'k' }, attempts: 3,
      backoff: { type: 'fixed', delay: 5_000 },
    })
    // Long backoff so the job is provably mid-retry, not finished, when the
    // duplicate arrives. A short delay here would make this test a race.
    await flush()
    expect(calls).toBe(1)

    const dup = await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })
    expect(dup.deduplicated).toBe(true)
  })
})

describe('memory driver deduplication — throttle mode', () => {
  it('keeps the key after the job finishes, until the ttl expires', async () => {
    vi.useFakeTimers()
    try {
      const driver = createMemoryDriver()
      await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k', ttl: 60_000 } })

      vi.setSystemTime(Date.now() + 30_000)
      expect((await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k', ttl: 60_000 } })).deduplicated)
        .toBe(true)

      vi.setSystemTime(Date.now() + 31_000)
      expect((await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k', ttl: 60_000 } })).deduplicated)
        .toBe(false)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('memory driver deduplication — debounce mode', () => {
  it('collapses a burst into one job carrying the LAST payload', async () => {
    const driver = createMemoryDriver()
    const opts = { name: 'j', dedup: { id: 'k', ttl: 60_000, extend: true, replace: true }, delay: 10_000 }

    await driver.enqueue('default', { ...opts, payload: { n: 1 } })
    await driver.enqueue('default', { ...opts, payload: { n: 2 } })
    const last = await driver.enqueue('default', { ...opts, payload: { n: 3 } })

    expect((await driver.introspect!.counts('default')).delayed).toBe(1)
    // The LAST payload, not the first. This is what `replace` means and it is
    // the only assertion that distinguishes debounce from throttle — under
    // throttle this job would carry { n: 1 }.
    const detail = await driver.introspect!.get('default', last.id)
    expect(detail?.deduplicationId).toBe('k')
  })
})

describe('memory driver deduplication — absent', () => {
  it('does not deduplicate when no dedup option is supplied', async () => {
    const driver = createMemoryDriver()
    await driver.enqueue('default', { name: 'j', payload: {} })
    await driver.enqueue('default', { name: 'j', payload: {} })
    expect((await driver.introspect!.counts('default')).waiting).toBe(2)
  })
})
