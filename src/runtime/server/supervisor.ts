import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { createDriver, resolveDriverName } from './drivers'
import type { ConciergeDriver, Consumer } from './drivers'
import type { AnyJobDefinition, BackoffOptions, Role, SupervisorState, WorkerRecord } from './types'
import { startNoWorkerWatch } from './guardrails'
import type {
  BullmqOptions,
  ConnectionOptions,
  DriverName,
  JobDefaults,
  WorkerOptions,
} from '../../options'

const logger = consola.create({}).withTag('nuxt-concierge')

/**
 * What the producer needs to know about a job in order to enqueue it.
 *
 * Replaces the old `Map<string, string>` name -> queue map: the producer now
 * also validates (so it needs `input`) and attaches retry options at
 * `add()` time (so it needs `attempts`/`backoff`), because BullMQ takes both
 * as job options rather than worker options.
 */
export interface RegistryEntry {
  queue: string
  input?: StandardSchemaV1
  attempts?: number
  backoff?: BackoffOptions
}

export interface SupervisorConfig {
  role: Role
  driver: DriverName
  connection: ConnectionOptions
  bullmq: BullmqOptions
  worker: WorkerOptions
  defaults: JobDefaults
  jobs: AnyJobDefinition[]
  version: string
  /**
   * Resolved at build time by the host module, not read from process.env at
   * runtime here: Nitro's production bundling statically inlines
   * `process.env.NODE_ENV`, which freezes an `auto` driver's guardrail
   * decision into the built artifact with no runtime escape hatch. Reading
   * it off runtimeConfig instead keeps it overridable via the standard
   * NUXT_CONCIERGE_IS_PRODUCTION env var.
   */
  isProduction: boolean
}

export interface Supervisor {
  readonly id: string
  readonly driver: ConciergeDriver
  readonly registry: Map<string, RegistryEntry>
  readonly consumers: Map<string, Consumer>
  readonly config: SupervisorConfig
  getState: () => SupervisorState
  setState: (state: SupervisorState) => void
  startConsumers: () => Promise<void>
  /**
   * Stops the heartbeat interval without touching consumers or the driver.
   * Idempotent. Shutdown (`src/runtime/server/shutdown.ts`) calls this before deregistering: a tick
   * landing between `deregister()` resolving and `driver.close()` would
   * otherwise re-write the worker record with a fresh TTL, leaving a
   * phantom worker in the registry after the process is already gone.
   *
   * Returns a promise that settles once any heartbeat write already in
   * flight when this was called has itself settled — clearing the interval
   * alone only stops FUTURE ticks; the most recent tick may have already
   * launched a fire-and-forget `driver.heartbeat(...)` write that is still
   * pending. Callers that deregister right after calling this must await it,
   * or that in-flight write can land after deregister() and recreate the
   * worker record with a fresh TTL — the exact phantom-worker case this
   * ordering exists to prevent.
   */
  stopHeartbeat: () => Promise<void>
  record: () => WorkerRecord
  stop: () => Promise<void>
}

let current: Supervisor | undefined

export const getSupervisor = (): Supervisor | undefined => current

/**
 * Actually tears down the current supervisor (clears the heartbeat interval,
 * closes consumers and the driver) rather than just dropping the reference.
 * Every supervisor test relies on this: if an assertion fails before its
 * trailing `await s.stop()`, an un-torn-down heartbeat interval and the
 * memory driver's poll loop would otherwise leak into the rest of the suite.
 */
export const resetSupervisor = async (): Promise<void> => {
  if (current) await current.stop()
  current = undefined
}

export const getDriver = () => {
  if (!current) throw new Error('[nuxt-concierge] the supervisor has not started yet')
  return {
    driver: current.driver,
    registry: current.registry,
    defaults: current.config.defaults,
  }
}

export const createSupervisor = async (config: SupervisorConfig): Promise<Supervisor> => {
  const queueNames = Object.keys(config.worker.queues)

  // A job naming an undeclared queue is a boot error, not a silently orphaned
  // job that never runs and never reports why.
  for (const job of config.jobs) {
    if (!queueNames.includes(job.queue)) {
      throw new Error(
        `[nuxt-concierge] job "${job.name}" targets queue "${job.queue}", which is not declared in `
        + `concierge.worker.queues (declared: ${queueNames.join(', ') || 'none'}).`,
      )
    }
  }

  // A second createSupervisor() call (successive tests, or a dev-mode nitro
  // reload) must not leak the previous supervisor's timer, consumers and
  // driver. Stopping the live one first rather than refusing keeps both
  // paths simple; there is no scenario where two supervisors should ever be
  // live at once.
  if (current) await current.stop()

  const driverName = resolveDriverName({
    configured: config.driver,
    hasConnection: Boolean(config.connection.url ?? config.connection.host),
    isProduction: config.isProduction,
  })

  const driver = await createDriver(driverName, {
    connection: config.connection,
    bullmq: config.bullmq,
  })
  await driver.init()

  // `run`, not `handler`: `run` is the driver-facing wrapper that validates
  // the decoded payload before delegating. Registering `handler` would skip
  // consumer-side validation entirely.
  for (const job of config.jobs) driver.registerHandler(job.queue, job.name, job.run)

  const registry = new Map<string, RegistryEntry>(
    config.jobs.map(job => [job.name, {
      queue: job.queue,
      input: job.input,
      attempts: job.attempts,
      backoff: job.backoff,
    }]),
  )
  const consumers = new Map<string, Consumer>()
  const id = randomUUID().slice(0, 8)
  const startedAt = Date.now()

  let state: SupervisorState = 'starting'
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let started = false
  let stopWatch: (() => void) | undefined
  // Tracks the most recently launched heartbeat write, cleared once it
  // settles. stopHeartbeat() awaits this so a tick that already fired before
  // the interval was cleared cannot land after deregister() and recreate the
  // worker record with a fresh TTL.
  let pendingHeartbeat: Promise<void> | undefined

  const supervisor: Supervisor = {
    id,
    driver,
    registry,
    consumers,
    config,

    getState: () => state,
    setState: (next) => { state = next },

    stopHeartbeat: async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
      }
      await pendingHeartbeat
    },

    record: () => ({
      id,
      hostname: hostname(),
      pid: process.pid,
      role: config.role,
      queues: queueNames,
      concurrency: config.worker.queues,
      version: config.version,
      startedAt,
      lastHeartbeat: Date.now(),
      state: state === 'draining' ? 'draining' : 'running',
      // Snapshotted here rather than written per job transition: doing it on
      // start/finish would add two registry writes per job to the hot path.
      active: [...consumers.values()].flatMap(c => c.active()),
    }),

    startConsumers: async () => {
      // A second call must not re-create consumers or leak a second
      // heartbeat interval on top of the first.
      if (started) return
      started = true

      if (config.role !== 'web') {
        for (const [queue, concurrency] of Object.entries(config.worker.queues)) {
          consumers.set(queue, driver.consume(queue, { concurrency }))
        }

        heartbeatTimer = setInterval(() => {
          try {
            // Tracked so stopHeartbeat() can await this exact write: clearing
            // the interval only stops FUTURE ticks, but this one has already
            // started and must not be allowed to land after deregister().
            pendingHeartbeat = driver.heartbeat(supervisor.record(), config.worker.heartbeatTtl)
              .catch((error: unknown) => logger.warn('[nuxt-concierge] heartbeat failed', error))
              .finally(() => { pendingHeartbeat = undefined })
          }
          catch (error) {
            // A throwing record() (e.g. a consumer.active() bug) would
            // otherwise be an uncaught timer exception; keep the interval
            // firing regardless.
            logger.warn('[nuxt-concierge] heartbeat failed', error)
          }
        }, config.worker.heartbeatInterval)
        // Never hold the process open on its own — only actual work should.
        heartbeatTimer.unref?.()

        // Beat once immediately so a worker is visible before the first
        // interval tick. A worker whose registry writes all fail must stay
        // loud about it, not silently expire from the registry.
        try {
          await driver.heartbeat(supervisor.record(), config.worker.heartbeatTtl)
        }
        catch (error) {
          logger.warn('[nuxt-concierge] heartbeat failed', error)
        }
      }
      else {
        stopWatch = startNoWorkerWatch(supervisor)
      }

      state = 'running'
    },

    stop: async () => {
      stopWatch?.()
      await supervisor.stopHeartbeat()
      await Promise.allSettled([...consumers.values()].map(c => c.close(true)))
      consumers.clear()
      await driver.deregister(id).catch(() => {})
      await driver.close(true).catch(() => {})
      state = 'stopped'
      if (current === supervisor) current = undefined
    },
  }

  current = supervisor
  return supervisor
}
