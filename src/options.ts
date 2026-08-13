import defu from 'defu'
import type { BackoffOptions, Role } from './runtime/server/types'

export type DriverName = 'auto' | 'sync' | 'memory' | 'bullmq'

export interface ConnectionOptions {
  url?: string
  host?: string
  port?: number
  password?: string
}

export interface WorkerOptions {
  /**
   * Queue name -> concurrency. Does double duty: it is both the concurrency
   * map and the queue declaration, since defineQueue is gone. A job naming a
   * queue absent from this map is a boot-time error.
   */
  queues: Record<string, number>
  /** Must stay strictly below NITRO_SHUTDOWN_TIMEOUT (default 30_000). */
  shutdownTimeout: number
  heartbeatInterval: number
  heartbeatTtl: number
}

export interface BullmqOptions {
  /** BullMQ's default is 1, which fails a job permanently after two force-closes. */
  maxStalledCount: number
  /** Configurable because a force-closed job is not retried until it elapses. */
  stalledInterval: number
}

/** Retry policy applied to any job that does not declare its own. */
export interface JobDefaults {
  /** TOTAL attempts including the first, matching BullMQ. */
  attempts: number
  backoff: BackoffOptions
}

/**
 * What a user writes in `nuxt.config.ts`. Every field is optional — and
 * `worker`/`bullmq`/`defaults` are partial — so nothing needs to be restated
 * by a consumer. This is the type `defineNuxtModule` is parameterised with, so
 * it is what the `concierge` config key is typed as for consumers.
 *
 * `resolveModuleOptions` is what fills the gaps from `moduleDefaults`, and it
 * is the ONLY thing that does. `defineNuxtModule` is deliberately given no
 * `defaults` option: `@nuxt/kit` applies those with a deep `defu` before
 * `setup()` runs, which silently merged a user's `worker.queues` into the
 * default map instead of replacing it — leaving a `default` queue declared
 * that the user never asked for, and letting a job that forgot its `queue:`
 * run there instead of tripping the "targets an undeclared queue" boot error.
 *
 * This used to be the fully-required shape, which meant `worker: { queues }`
 * — the normal case — failed to typecheck with "missing the following
 * properties: heartbeatInterval, heartbeatTtl". The resolved shape is
 * `ResolvedConciergeOptions` below.
 */
export interface ModuleOptions {
  driver?: DriverName
  connection?: ConnectionOptions
  role?: Role
  worker?: Partial<WorkerOptions>
  bullmq?: Partial<BullmqOptions>
  /**
   * Partial at BOTH levels, deliberately. `Partial<JobDefaults>` alone makes
   * `backoff` optional while still demanding both of its members, so a valid
   * `defaults: { backoff: { type: 'fixed' } }` fails to typecheck with
   * "Property 'delay' is missing" — even though `resolveModuleOptions` fills
   * `delay` from `moduleDefaults` perfectly well, because `defu` merges
   * nested objects.
   *
   * That is the same defect `worker?: Partial<WorkerOptions>` exists to fix,
   * one level deeper: a type demanding a value the resolver already supplies.
   */
  defaults?: {
    /** TOTAL attempts including the first. Must be at least 1. */
    attempts?: number
    backoff?: Partial<BackoffOptions>
  }
  /** BullBoard dashboard. Unchanged in phase 1; replaced in spec 4. */
  managementUI?: boolean
}

/**
 * The fully-resolved shape `resolveModuleOptions` returns. `moduleDefaults`
 * must satisfy this type; code that reads options after the module has resolved
 * them can rely on every field being present, unlike `ModuleOptions` above.
 */
export interface ResolvedConciergeOptions {
  driver: DriverName
  connection: ConnectionOptions
  role?: Role
  worker: WorkerOptions
  bullmq: BullmqOptions
  defaults: JobDefaults
  managementUI?: boolean
}

export const moduleDefaults: ResolvedConciergeOptions = {
  driver: 'auto',
  connection: { url: process.env.REDIS_URL },
  role: undefined,
  worker: {
    queues: { default: 5 },
    shutdownTimeout: 20_000,
    heartbeatInterval: 5_000,
    heartbeatTtl: 15_000,
  },
  bullmq: {
    maxStalledCount: 3,
    stalledInterval: 30_000,
  },
  defaults: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
  managementUI: process.env.NODE_ENV === 'development',
}

export const resolveModuleOptions = (options: ModuleOptions): ResolvedConciergeOptions => {
  const merged = defu(options, moduleDefaults) as ResolvedConciergeOptions

  return {
    ...merged,
    worker: {
      ...merged.worker,
      // REPLACED, not merged. defu merges objects, so a user declaring
      // `queues: { mail: 2 }` would keep the default `default: 5` as well —
      // starting a consumer for a queue they never declared, and making the
      // no-worker guardrail watch a queue nothing enqueues to.
      //
      // Shallow-copied on the no-override branch: `moduleDefaults` is a
      // module-level singleton, and handing out the same object reference to
      // every caller that omits `worker.queues` would let one caller's
      // in-place mutation corrupt the default for every later resolution.
      queues: options.worker?.queues ?? { ...moduleDefaults.worker.queues },
    },
  }
}
