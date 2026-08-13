import type { Role } from './runtime/server/types'

export type DriverName = 'auto' | 'sync' | 'memory' | 'bullmq'

export interface ConnectionOptions {
  url?: string
  host?: string
  port?: number
  password?: string
}

export interface WorkerOptions {
  /**
   * Queue name -> concurrency. Does double duty in phase 1: it is both the
   * concurrency map and the queue declaration, since defineQueue is gone.
   * A job naming a queue absent from this map is a boot-time error.
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

/**
 * What a user writes in `nuxt.config.ts`. Every field is optional — and
 * `worker`/`bullmq` are partial — because `defu` merges whatever is given
 * here against `moduleDefaults` (see `ResolvedConciergeOptions`) before any
 * code reads it, so nothing needs to be restated by a consumer. This is the
 * type `defineNuxtModule` is parameterised with, so it is what the
 * `concierge` config key is typed as for consumers.
 */
export interface ModuleOptions {
  driver?: DriverName
  connection?: ConnectionOptions
  role?: Role
  worker?: Partial<WorkerOptions>
  bullmq?: Partial<BullmqOptions>
  /** BullBoard dashboard. Unchanged in phase 1; replaced in spec 4. */
  managementUI?: boolean
}

/**
 * The fully-merged shape once `defu` has applied `moduleDefaults` on top of
 * whatever a user wrote. `moduleDefaults` must satisfy this type; code that
 * reads options after the module has resolved them can rely on every field
 * being present, unlike `ModuleOptions` above.
 */
export interface ResolvedConciergeOptions {
  driver: DriverName
  connection: ConnectionOptions
  role?: Role
  worker: WorkerOptions
  bullmq: BullmqOptions
  /** BullBoard dashboard. Unchanged in phase 1; replaced in spec 4. */
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
  managementUI: process.env.NODE_ENV === 'development',
}
