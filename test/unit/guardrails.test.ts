import { describe, it, expect } from 'vitest'
import { checkGuardrails, guardrailDiagnostics } from '../../src/runtime/server/guardrails'

const base = {
  role: 'both' as const,
  capabilities: { persistent: true, crossProcess: true },
  driverName: 'bullmq',
  queueCount: 1,
  isProduction: false,
  shutdownTimeout: 20_000,
  nitroShutdownTimeout: 30_000,
  nitroShutdownDisabled: false,
  preset: 'node-server',
}

describe('guardrails', () => {
  it('passes a sane configuration', () => {
    expect(guardrailDiagnostics(base)).toEqual([])
  })

  it('throws for a non-crossProcess driver outside role: both', () => {
    // Derived from capability, not driver name, so it covers memory+worker and
    // sync+worker with one rule and any future driver for free.
    expect(() => checkGuardrails({
      ...base,
      role: 'worker',
      driverName: 'memory',
      capabilities: { persistent: false, crossProcess: false },
    })).toThrow(/memory.*cannot be used with role "worker"/)
  })

  it('rule 1 message names the driver, the offending role, and both escapes', () => {
    // Actionable from the message alone: CONCIERGE_ROLE is called out
    // specifically because in a deployed setting that is where role usually
    // comes from, not the config file.
    const d = guardrailDiagnostics({
      ...base,
      role: 'worker',
      driverName: 'memory',
      capabilities: { persistent: false, crossProcess: false },
    })
    const fatal = d.find(x => x.level === 'error')
    expect(fatal).toBeDefined()
    expect(fatal?.message).toMatch(/"memory"/)
    expect(fatal?.message).toMatch(/role "worker"/)
    expect(fatal?.message).toMatch(/role:\s*'both'/)
    expect(fatal?.message).toMatch(/CONCIERGE_ROLE=both/)
    expect(fatal?.message).toMatch(/bullmq/)
  })

  it('allows a non-crossProcess driver under role: both', () => {
    expect(() => checkGuardrails({
      ...base,
      role: 'both',
      driverName: 'memory',
      capabilities: { persistent: false, crossProcess: false },
    })).not.toThrow()
  })

  it('warns but does not throw for a non-persistent driver in production', () => {
    const d = guardrailDiagnostics({
      ...base,
      isProduction: true,
      capabilities: { persistent: false, crossProcess: true },
    })
    expect(d.some(x => x.level === 'warn' && /persist/i.test(x.message))).toBe(true)
    expect(d.some(x => x.level === 'error')).toBe(false)
  })

  it('warns when a worker has no queues configured', () => {
    const d = guardrailDiagnostics({ ...base, role: 'worker', queueCount: 0 })
    expect(d.some(x => /no queues/i.test(x.message))).toBe(true)
  })

  it('warns when shutdownTimeout is not below NITRO_SHUTDOWN_TIMEOUT', () => {
    const d = guardrailDiagnostics({ ...base, shutdownTimeout: 30_000, nitroShutdownTimeout: 30_000 })
    expect(d.some(x => /NITRO_SHUTDOWN_TIMEOUT/.test(x.message))).toBe(true)
  })

  it('warns loudly when NITRO_SHUTDOWN_DISABLED is set', () => {
    // Close hooks never fire, so the drain silently never runs and every
    // deploy drops in-flight jobs.
    const d = guardrailDiagnostics({ ...base, nitroShutdownDisabled: true })
    expect(d.some(x => /NITRO_SHUTDOWN_DISABLED/.test(x.message))).toBe(true)
  })

  it('warns on a serverless preset with a non-persistent driver', () => {
    const d = guardrailDiagnostics({
      ...base,
      preset: 'vercel',
      capabilities: { persistent: false, crossProcess: true },
    })
    expect(d.some(x => /serverless/i.test(x.message))).toBe(true)
  })
})
