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
