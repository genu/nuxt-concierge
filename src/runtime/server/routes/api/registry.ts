import { readFileSync } from 'node:fs'
import { defineEventHandler } from 'h3'
import { useRuntimeConfig } from '#imports'
import { getSupervisor } from '../../supervisor'
import type { Supervisor } from '../../supervisor'

export interface RegistryJobView {
  name: string
  queue: string
  file?: string
  hasSchema: boolean
  /** e.g. "zod", "valibot", "arktype". Never a payload TYPE — that is erased at build. */
  schemaVendor?: string
  attempts: { value: number, from: 'job' | 'defaults' }
  backoff: { value: { type: string, delay: number }, from: 'job' | 'defaults' }
}

export interface RegistryResponse {
  jobs: RegistryJobView[]
  /** The generated job map .d.ts, verbatim. Undefined when unavailable. */
  generatedTypes?: string
}

/**
 * Registered only under nuxt.options.dev (see src/module.ts), so this file is
 * never part of a production bundle. It therefore needs no auth check — there
 * is deliberately no configuration that makes it reachable in production.
 *
 * Takes no queue param (unlike the other three dev endpoints), so there is no
 * queue allowlist check here — the only untrusted-ish input is `typesPath`,
 * and that is not attacker input either: it is written by the module itself
 * at build time, never derived from a request.
 */
export const buildRegistry = (
  supervisor: Supervisor | undefined,
  jobFiles: Record<string, string>,
  typesPath: string | undefined,
): RegistryResponse => {
  if (!supervisor) return { jobs: [] }

  const { defaults } = supervisor.config
  const jobs: RegistryJobView[] = [...supervisor.registry.entries()].map(([name, entry]) => {
    const schema = entry.input
    return {
      name,
      queue: entry.queue,
      file: jobFiles[name],
      hasSchema: Boolean(schema),
      // Read off the Standard Schema spec's own metadata. This is the most the
      // runtime knows about a schema — the payload type is compile-time only.
      schemaVendor: schema?.['~standard'].vendor,
      attempts: entry.attempts !== undefined
        ? { value: entry.attempts, from: 'job' as const }
        : { value: defaults.attempts, from: 'defaults' as const },
      backoff: entry.backoff !== undefined
        ? { value: entry.backoff, from: 'job' as const }
        : { value: defaults.backoff, from: 'defaults' as const },
    }
  })

  let generatedTypes: string | undefined
  if (typesPath) {
    try {
      generatedTypes = readFileSync(typesPath, 'utf8')
    }
    catch {
      // A missing .d.ts is a dev-setup detail, not a reason to fail the whole
      // endpoint and take the job table down with it.
      generatedTypes = undefined
    }
  }

  return { jobs, generatedTypes }
}

export default defineEventHandler(() => {
  const config = useRuntimeConfig().concierge as {
    jobFiles?: Record<string, string>
    generatedTypesPath?: string
  }
  return buildRegistry(getSupervisor(), config.jobFiles ?? {}, config.generatedTypesPath)
})
