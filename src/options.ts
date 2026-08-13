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
 * What a user writes in `nuxt.config.ts`. Every field is optional and nested
 * objects are `Partial`, because `resolveModuleOptions` fills the gaps from
 * `moduleDefaults`.
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
  defaults?: Partial<JobDefaults>
  /** BullBoard dashboard. Unchanged in phase 1; replaced in spec 4. */
  managementUI?: boolean
}

/** What the runtime receives, after defaults are applied. */
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
      queues: options.worker?.queues ?? moduleDefaults.worker.queues,
    },
  }
}
