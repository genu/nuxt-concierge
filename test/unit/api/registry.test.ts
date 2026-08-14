import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import type { Supervisor } from '../../../src/runtime/server/supervisor'

// registry.ts's default export (the route handler) imports useRuntimeConfig
// from '#imports', which only resolves inside a Nuxt/Nitro build. This file
// only exercises the pure, exported `buildRegistry` — which never touches
// runtime config itself — so '#imports' is stubbed purely to make the module
// importable under plain vitest, exactly like role-gate.test.ts.
vi.mock('#imports', () => ({ useRuntimeConfig: () => ({ concierge: {} }) }))

const { buildRegistry } = await import('../../../src/runtime/server/routes/api/registry')

const fakeSupervisor = () => ({
  registry: new Map([
    ['send-email', {
      queue: 'mail',
      input: z.object({ to: z.string() }),
      attempts: 5,
      backoff: { type: 'fixed', delay: 250 },
    }],
    ['sweep', { queue: 'default' }],
  ]),
  config: {
    worker: { queues: { mail: 2, default: 5 } },
    defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
  },
} as unknown as Supervisor)

describe('buildRegistry', () => {
  it('reports the schema vendor for a job that declares one', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), {}, undefined)
    const job = jobs.find(j => j.name === 'send-email')!

    // The PAYLOAD TYPE is erased at build and cannot be recovered at runtime.
    // Vendor and presence are what actually exist, and saying so is better than
    // a panel implying it computed a type.
    expect(job.hasSchema).toBe(true)
    expect(job.schemaVendor).toBe('zod')
  })

  it('reports no schema for a job that declares none, without inventing a vendor', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), {}, undefined)
    const job = jobs.find(j => j.name === 'sweep')!

    expect(job.hasSchema).toBe(false)
    expect(job.schemaVendor).toBeUndefined()
  })

  it('distinguishes a job-declared retry policy from an inherited default', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), {}, undefined)

    // Both halves. "attempts: 5" alone does not tell a developer whether the
    // job set it or inherited it — which is the whole question you open this
    // panel to answer.
    expect(jobs.find(j => j.name === 'send-email')!.attempts).toEqual({ value: 5, from: 'job' })
    expect(jobs.find(j => j.name === 'sweep')!.attempts).toEqual({ value: 3, from: 'defaults' })
  })

  it('distinguishes a job-declared backoff policy from an inherited default', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), {}, undefined)

    // Same distinction as attempts, and just as load-bearing: a job's own
    // `backoff` and one it silently inherited from `concierge.defaults` look
    // identical as a bare value.
    expect(jobs.find(j => j.name === 'send-email')!.backoff).toEqual({
      value: { type: 'fixed', delay: 250 },
      from: 'job',
    })
    expect(jobs.find(j => j.name === 'sweep')!.backoff).toEqual({
      value: { type: 'exponential', delay: 1000 },
      from: 'defaults',
    })
  })

  it('includes the source file when the module supplied one', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), { 'send-email': '/app/server/jobs/send-email.ts' }, undefined)
    expect(jobs.find(j => j.name === 'send-email')!.file).toBe('/app/server/jobs/send-email.ts')
  })

  it('omits generated types rather than failing when the path is absent', () => {
    const result = buildRegistry(fakeSupervisor(), {}, undefined)
    // The panel must still render its job table. A missing .d.ts is a dev-setup
    // detail, not a reason to 500 the whole endpoint.
    expect(result.generatedTypes).toBeUndefined()
    expect(result.jobs).toHaveLength(2)
  })
})
