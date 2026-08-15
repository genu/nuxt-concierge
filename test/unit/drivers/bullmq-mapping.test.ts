import { describe, it, expect, vi } from 'vitest'
import { Queue, UnrecoverableError } from 'bullmq'
import {
  buildConnection,
  bullmqAddOptions,
  createBullmqDriver,
  isPermanentFailure,
  resolveBullmqOptions,
  workerRecordKey,
  WORKER_KEY_PREFIX,
} from '../../../src/runtime/server/drivers/bullmq'
import { encodePayload, UnsupportedEnvelopeError } from '../../../src/runtime/server/envelope'

/**
 * `consume()` reaches into a real `bullmq` `Worker`, which opens a real Redis
 * connection on construction. Mocking the module lets this test drive the
 * exact processor function the driver registers — the seam that converts a
 * `retryable === false` throw into `UnrecoverableError` — without a live
 * Redis, and without touching anything the other tests in this file exercise
 * (they only call the pure helpers above, never `consume`).
 */
const { capturedProcessors } = vi.hoisted(() => ({
  capturedProcessors: [] as Array<(job: unknown) => Promise<void>>,
}))

vi.mock('bullmq', () => {
  class UnrecoverableError extends Error {}
  class Worker {
    constructor(_name: string, processor: (job: unknown) => Promise<void>) {
      capturedProcessors.push(processor)
    }

    on() { return this }
    close = vi.fn(async () => {})
    pause = vi.fn(async () => {})
  }
  class Queue {
    close = vi.fn(async () => {})
    // A real prototype method (not a class field) so `vi.spyOn(Queue.prototype,
    // 'add')` in the retry-options test below has something to replace.
    async add() { return { id: '1' } }
  }
  return { Worker, Queue, UnrecoverableError }
})

describe('bullmq connection mapping', () => {
  it('prefers a url when given', () => {
    expect(buildConnection({ url: 'redis://user:pw@example:6380' }))
      .toEqual({ url: 'redis://user:pw@example:6380' })
  })

  it('falls back to discrete fields', () => {
    expect(buildConnection({ host: 'h', port: 6379, password: 'p' }))
      .toEqual({ host: 'h', port: 6379, password: 'p' })
  })

  it('throws when neither is usable rather than silently connecting to localhost', () => {
    expect(() => buildConnection({})).toThrow(/connection/i)
  })
})

describe('worker record keys', () => {
  it('namespaces keys so they cannot collide with queue keys', () => {
    expect(workerRecordKey('abc')).toBe(`${WORKER_KEY_PREFIX}abc`)
    expect(WORKER_KEY_PREFIX).toMatch(/^concierge:workers:/)
  })
})

describe('resolveBullmqOptions', () => {
  it('applies both defaults when nothing is given', () => {
    expect(resolveBullmqOptions()).toEqual({ maxStalledCount: 3, stalledInterval: 30_000 })
  })

  it('respects a full explicit override', () => {
    expect(resolveBullmqOptions({ maxStalledCount: 7, stalledInterval: 1_000 }))
      .toEqual({ maxStalledCount: 7, stalledInterval: 1_000 })
  })

  it('fills a missing field from defaults instead of dropping it', () => {
    expect(resolveBullmqOptions({ maxStalledCount: 5 }))
      .toEqual({ maxStalledCount: 5, stalledInterval: 30_000 })
    expect(resolveBullmqOptions({ stalledInterval: 2_000 }))
      .toEqual({ maxStalledCount: 3, stalledInterval: 2_000 })
  })
})

describe('isPermanentFailure', () => {
  it('is true for UnsupportedEnvelopeError, which marks itself non-retryable', () => {
    expect(isPermanentFailure(new UnsupportedEnvelopeError('bad payload'))).toBe(true)
  })

  it('is false for a plain Error', () => {
    expect(isPermanentFailure(new Error('boom'))).toBe(false)
  })

  it('is false for a non-Error throwable like a string', () => {
    expect(isPermanentFailure('boom')).toBe(false)
  })

  it('is true for any object literal carrying retryable: false', () => {
    expect(isPermanentFailure({ retryable: false })).toBe(true)
  })
})

describe('consume() job processor', () => {
  it('converts a retryable:false error thrown by a registered handler into UnrecoverableError', async () => {
    const driver = createBullmqDriver({ connection: { url: 'redis://127.0.0.1:6379' } })

    class ValidationLikeError extends Error {
      readonly retryable = false
    }

    const handler = vi.fn(async () => {
      throw new ValidationLikeError('payload invalid')
    })

    driver.consume('q', { concurrency: 1 }, handler)

    const processor = capturedProcessors.at(-1)!
    const job = {
      id: 'job-1',
      name: 'j',
      processedOn: Date.now(),
      attemptsMade: 0,
      data: encodePayload({ n: 1 }),
    }

    await expect(processor(job)).rejects.toThrow(UnrecoverableError)

    // Both halves: the conversion must actually run through a registered
    // handler thrown from `consume()`'s real processor — not merely prove
    // `isPermanentFailure` returns true for a synthetic object, which the
    // suite above already covers.
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('leaves a plain retryable error alone so BullMQ still retries it', async () => {
    const driver = createBullmqDriver({ connection: { url: 'redis://127.0.0.1:6379' } })

    const handler = vi.fn(async () => {
      throw new Error('transient failure')
    })

    driver.consume('q2', { concurrency: 1 }, handler)

    const processor = capturedProcessors.at(-1)!
    const job = {
      id: 'job-2',
      name: 'j',
      processedOn: Date.now(),
      attemptsMade: 0,
      data: encodePayload({ n: 1 }),
    }

    // Captured as a value (not inspected inside a catch clause) so the
    // assertions below are unconditional: they run whether or not the
    // promise actually rejects, rather than being skipped if it resolves.
    const rejection: unknown = await processor(job).catch((e: unknown) => e)

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).not.toBeInstanceOf(UnrecoverableError)
    expect((rejection as Error).message).toBe('transient failure')
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('bullmq enqueue retry options', () => {
  it('passes attempts and backoff to queue.add', async () => {
    const add = vi.fn().mockResolvedValue({ id: '1' })
    const driver = createBullmqDriver({ connection: { url: 'redis://localhost:6379' } })
    // Replace the lazily-created Queue with a stub. Asserting on the real
    // BullMQ call arguments is what makes this test about the mapping rather
    // than about Redis.
    vi.spyOn(Queue.prototype, 'add').mockImplementation(add)

    await driver.enqueue('default', {
      name: 'j',
      payload: { a: 1 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 250 },
    })

    expect(add).toHaveBeenCalledWith(
      'j',
      expect.anything(),
      expect.objectContaining({ attempts: 5, backoff: { type: 'exponential', delay: 250 } }),
    )
  })

  it('does not send a defaulted attempts value when none was supplied', async () => {
    const add = vi.fn().mockResolvedValue({ id: '1' })
    const driver = createBullmqDriver({ connection: { url: 'redis://localhost:6379' } })
    vi.spyOn(Queue.prototype, 'add').mockImplementation(add)

    await driver.enqueue('default', { name: 'j', payload: {} })

    // BullMQ's own default is attempts: 0, whose retry condition
    // (attemptsMade + 1 < attempts) is never true. Sending an explicit 0 or
    // undefined must not be confused with sending 1.
    const opts = add.mock.calls[0]![2] as Record<string, unknown>
    expect(opts.attempts).toBeUndefined()
    expect(opts.backoff).toBeUndefined()
  })
})

describe('bullmqAddOptions', () => {
  it('passes dedup straight through with no translation', () => {
    // Straight through, deliberately: EnqueueOptions.dedup is shaped exactly
    // like BullMQ's DeduplicationOptions. A translation layer here is where a
    // semantic drift would hide, the same reasoning that keeps BackoffOptions
    // shaped like BullMQ's own.
    const opts = bullmqAddOptions({
      name: 'j', payload: {}, dedup: { id: 'k', ttl: 5_000, extend: true, replace: true },
    })
    expect(opts.deduplication).toEqual({ id: 'k', ttl: 5_000, extend: true, replace: true })
  })

  it('omits deduplication entirely when the job declares none', () => {
    // `undefined` rather than `{}`: BullMQ's check is truthiness
    // (`if (this.opts.deduplication)`), so `deduplication: undefined` behaves
    // identically to an omitted key — but a truthy empty object would still
    // take the deduplicate path, with an undefined `id`.
    expect(bullmqAddOptions({ name: 'j', payload: {} }).deduplication).toBeUndefined()
  })

  it('never sets the deprecated debounce option', () => {
    // `debounce` is deprecated in favour of `deduplication` in 5.63.0 and
    // takes the identical shape, so building on it would work today and break
    // silently at the v6 removal.
    const opts = bullmqAddOptions({ name: 'j', payload: {}, dedup: { id: 'k' } })
    expect(opts).not.toHaveProperty('debounce')
  })

  it('still carries attempts, backoff and delay', () => {
    const opts = bullmqAddOptions({
      name: 'j', payload: {}, delay: 100, attempts: 3, backoff: { type: 'fixed', delay: 50 },
    })
    expect(opts.delay).toBe(100)
    expect(opts.attempts).toBe(3)
    expect(opts.backoff).toEqual({ type: 'fixed', delay: 50 })
  })
})
