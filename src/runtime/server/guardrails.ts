import { consola } from 'consola'
import type { DriverCapabilities } from './drivers'
import type { Role } from './types'
// Type-only. supervisor.ts imports startNoWorkerWatch from this module, so a
// runtime import here would create a cycle — use the supervisor passed in.
import type { Supervisor } from './supervisor'

const logger = consola.create({}).withTag('nuxt-concierge')

const SERVERLESS_PRESETS = [
  'vercel', 'vercel-edge', 'netlify', 'netlify-edge', 'cloudflare',
  'cloudflare-pages', 'cloudflare-module', 'aws-lambda', 'azure',
]

export interface GuardrailInput {
  role: Role
  capabilities: DriverCapabilities
  driverName: string
  queueCount: number
  isProduction: boolean
  shutdownTimeout: number
  nitroShutdownTimeout: number
  nitroShutdownDisabled: boolean
  preset?: string
}

export interface Diagnostic {
  level: 'error' | 'warn'
  message: string
}

export const guardrailDiagnostics = (input: GuardrailInput): Diagnostic[] => {
  const out: Diagnostic[] = []

  if (!input.capabilities.crossProcess && input.role !== 'both') {
    out.push({
      level: 'error',
      message:
        `The "${input.driverName}" driver keeps state in-process, so it cannot be used with role "${input.role}": `
        + `a "${input.role}" process cannot see jobs enqueued or run by any other process. Fix this by either (1) `
        + `setting role: 'both' in your concierge config, or CONCIERGE_ROLE=both in the environment (the usual `
        + `place role comes from in a deployed process), to run a single combined process, or (2) switching to a `
        + `driver that works across processes, such as bullmq.`,
    })
  }

  if (!input.capabilities.persistent && input.isProduction) {
    out.push({
      level: 'warn',
      message:
        `The "${input.driverName}" driver does not persist jobs: everything queued is lost when this process exits. `
        + `This is running with NODE_ENV=production.`,
    })
  }

  if (input.role !== 'web' && input.queueCount === 0) {
    out.push({
      level: 'warn',
      message: `Role is "${input.role}" but no queues are configured, so this process will never do any work. `
        + `Declare queues in concierge.worker.queues.`,
    })
  }

  if (input.shutdownTimeout >= input.nitroShutdownTimeout) {
    out.push({
      level: 'warn',
      message:
        `concierge.worker.shutdownTimeout (${input.shutdownTimeout}ms) is not below NITRO_SHUTDOWN_TIMEOUT `
        + `(${input.nitroShutdownTimeout}ms). Nitro will abandon the drain mid-flight and exit, so workers will not `
        + `deregister. Note Nitro applies its timeout twice in sequence (HTTP drain, then close hooks), so set it to `
        + `roughly half your platform's grace period.`,
    })
  }

  if (input.nitroShutdownDisabled) {
    out.push({
      level: 'warn',
      message:
        `NITRO_SHUTDOWN_DISABLED is set, so Nitro never calls close hooks. The job drain will not run and every `
        + `deploy will drop in-flight jobs. Unset it to get graceful shutdown.`,
    })
  }

  if (input.preset && SERVERLESS_PRESETS.includes(input.preset) && !input.capabilities.persistent) {
    out.push({
      level: 'warn',
      message:
        `Preset "${input.preset}" is serverless and the "${input.driverName}" driver is not persistent. `
        + `Jobs will vanish on every cold start.`,
    })
  }

  return out
}

export const checkGuardrails = (input: GuardrailInput): void => {
  const diagnostics = guardrailDiagnostics(input)

  for (const d of diagnostics) {
    if (d.level === 'warn') logger.warn(d.message)
  }

  const fatal = diagnostics.find(d => d.level === 'error')
  if (fatal) throw new Error(`[nuxt-concierge] ${fatal.message}`)
}

const NO_WORKER_POLL_MS = 60_000
const NO_WORKER_THROTTLE_MS = 600_000

/**
 * Runs in the role: web supervisor, which starts no consumers. Deliberately
 * NOT on enqueue — that would put a registry read on the hot path.
 */
export const startNoWorkerWatch = (supervisor: Supervisor): (() => void) => {
  const lastWarned = new Map<string, number>()

  const timer = setInterval(() => {
    void (async () => {
      const s = supervisor
      if (s.getState() !== 'running') return

      try {
        const workers = await s.driver.workers()

        for (const queue of Object.keys(s.config.worker.queues)) {
          const claimed = workers.some(w => w.queues.includes(queue))
          if (claimed) continue

          const depth = await s.driver.depth(queue)
          if (depth === 0) continue

          const last = lastWarned.get(queue) ?? 0
          if (Date.now() - last < NO_WORKER_THROTTLE_MS) continue

          lastWarned.set(queue, Date.now())
          logger.warn(
            `Queue "${queue}" has ${depth} pending job(s) but no live worker is claiming it. `
            + `Start a worker process with CONCIERGE_ROLE=worker.`,
          )
        }
      }
      catch (error) {
        logger.debug('no-worker watch failed', error)
      }
    })()
  }, NO_WORKER_POLL_MS)

  timer.unref?.()
  return () => clearInterval(timer)
}
