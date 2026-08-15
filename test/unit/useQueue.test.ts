import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createSupervisor, resetSupervisor } from '../../src/runtime/server/supervisor'
import { useQueue } from '../../src/runtime/server/utils/useQueue'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'
import { JobPayloadInvalidError } from '../../src/runtime/server/validate'
import type { SupervisorConfig } from '../../src/runtime/server/supervisor'

const baseConfig = (jobs: SupervisorConfig['jobs']): SupervisorConfig => ({
  role: 'both',
  driver: 'memory',
  connection: {},
  bullmq: { maxStalledCount: 3, stalledInterval: 30_000 },
  worker: {
    queues: { default: 1 },
    shutdownTimeout: 20_000,
    heartbeatInterval: 5_000,
    heartbeatTtl: 15_000,
  },
  defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
  jobs,
  version: 'test',
  isProduction: false,
  cron: { enabled: true },
})

afterEach(async () => { await resetSupervisor() })

describe('useQueue().enqueue', () => {
  it('throws a named error for an unregistered job', async () => {
    await createSupervisor(baseConfig([]))

    await expect(useQueue().enqueue('nope', {})).rejects.toThrow(/no job named "nope"/)
  })

  it('routes to the queue from the job definition', async () => {
    const job = { ...defineJob<{ n: number }>({ handler: () => {} }), name: 'j', queue: 'default' }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('j', { n: 1 })

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({ name: 'j' }))
  })

  it('rejects an invalid payload and never reaches the driver', async () => {
    const job = {
      ...defineJob({ input: z.object({ n: z.number() }), handler: () => {} }),
      name: 'typed',
      queue: 'default',
    }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await expect(useQueue().enqueue('typed', { n: 'nope' })).rejects.toThrow(JobPayloadInvalidError)

    // Both halves. A throw that happened AFTER enqueueing would leave a job
    // in the queue that the worker is guaranteed to reject.
    expect(spy).not.toHaveBeenCalled()
  })

  it('enqueues the RAW input, not the schema output', async () => {
    const job = {
      ...defineJob({ input: z.object({ id: z.string().transform(Number) }), handler: () => {} }),
      name: 'typed',
      queue: 'default',
    }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('typed', { id: '42' })

    // The transform must happen exactly once, in the worker. Enqueueing `42`
    // here would make the consumer's z.string() reject its own output.
    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({ payload: { id: '42' } }))
  })

  it('applies the job attempts and backoff when declared', async () => {
    const job = {
      ...defineJob<undefined>({ attempts: 7, backoff: { type: 'fixed', delay: 50 }, handler: () => {} }),
      name: 'j',
      queue: 'default',
    }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('j', undefined)

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({
      attempts: 7,
      backoff: { type: 'fixed', delay: 50 },
    }))
  })

  it('falls back to the module defaults when the job declares neither', async () => {
    const job = { ...defineJob<undefined>({ handler: () => {} }), name: 'j', queue: 'default' }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('j', undefined)

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    }))
  })

  it('passes an explicit delay through', async () => {
    const job = { ...defineJob<undefined>({ handler: () => {} }), name: 'j', queue: 'default' }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('j', undefined, { delay: 5000 })

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({ delay: 5000 }))
  })
})

describe('useQueue deduplication', () => {
  it('passes no dedup option for a job that declares none', async () => {
    const job = defineJob({ name: 'plain', handler: () => {} })
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('plain', {})

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({ dedup: undefined }))
  })

  it('resolves lock mode to an id with no ttl', async () => {
    const job = defineJob({ name: 'u', unique: true, handler: () => {} })
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('u', { a: 1 })

    expect(spy.mock.calls[0]![1].dedup).toEqual({ id: expect.any(String) })
  })

  it("uses the job's uniqueId, namespaced by job name", async () => {
    const job = defineJob<{ id: number }>({
      name: 'invoice',
      unique: true,
      uniqueId: p => `i:${p.id}`,
      handler: () => {},
    })
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('invoice', { id: 7 })

    expect(spy.mock.calls[0]![1].dedup!.id).toBe('invoice:i:7')
  })

  it('derives the key from the RAW payload, before any transform', async () => {
    // uniqueId runs on the producer alongside validateOnEnqueue, whose result
    // is discarded — so the key must come from what the caller passed, not
    // from a transformed value that only exists in the worker. `n` is a string
    // here and a number after the transform, so a key of "t:n:5" proves the
    // raw side and "t:n:5" from a transformed payload would read the same —
    // which is why the assertion below also checks the payload handed to the
    // driver is still the raw one.
    const job = defineJob({
      name: 't',
      input: z.object({ n: z.string().transform(Number) }),
      unique: true,
      uniqueId: p => `n:${p.n}`,
      handler: () => {},
    })
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('t', { n: '5' })

    expect(spy.mock.calls[0]![1].dedup!.id).toBe('t:n:5')
    // Both halves: the transform must not have been applied to what was
    // enqueued either, which is spec 3's transform-once invariant.
    expect(spy.mock.calls[0]![1].payload).toEqual({ n: '5' })
  })

  it('returns the driver deduplicated flag to the caller', async () => {
    const job = defineJob({ name: 'u', unique: true, handler: () => {} })
    const supervisor = await createSupervisor(baseConfig([job]))
    vi.spyOn(supervisor.driver, 'enqueue').mockResolvedValue({ id: 'existing', deduplicated: true })

    await expect(useQueue().enqueue('u', {})).resolves.toEqual({ id: 'existing', deduplicated: true })
  })
})
