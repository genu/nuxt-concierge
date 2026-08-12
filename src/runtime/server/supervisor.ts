import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
import { createDriver, resolveDriverName } from './drivers'
import type { ConciergeDriver, Consumer } from './drivers'
import type { JobDefinition, Role, SupervisorState, WorkerRecord } from './types'

const logger = consola.create({}).withTag('nuxt-concierge')

export interface SupervisorConfig {
  role: Role
  driver: 'auto' | 'sync' | 'memory' | 'bullmq'
  connection: { url?: string, host?: string, port?: number, password?: string }
  bullmq: { maxStalledCount: number, stalledInterval: number }
  worker: {
    queues: Record<string, number>
    shutdownTimeout: number
    heartbeatInterval: number
    heartbeatTtl: number
  }
  jobs: JobDefinition[]
  version: string
}

export interface Supervisor {
  readonly id: string
  readonly driver: ConciergeDriver
  readonly routes: Map<string, string>
  readonly consumers: Map<string, Consumer>
  readonly config: SupervisorConfig
  getState: () => SupervisorState
  setState: (state: SupervisorState) => void
  startConsumers: () => Promise<void>
  record: () => WorkerRecord
  stop: () => Promise<void>
}

let current: Supervisor | undefined

export const getSupervisor = (): Supervisor | undefined => current
export const resetSupervisor = () => { current = undefined }

export const getDriver = () => {
  if (!current) throw new Error('[nuxt-concierge] the supervisor has not started yet')
  return { driver: current.driver, routes: current.routes }
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

  const driverName = resolveDriverName({
    configured: config.driver,
    hasConnection: Boolean(config.connection.url ?? config.connection.host),
    isProduction: process.env.NODE_ENV === 'production',
  })

  const driver = await createDriver(driverName, {
    connection: config.connection,
    bullmq: config.bullmq,
  })
  await driver.init()

  for (const job of config.jobs) driver.registerHandler(job.queue, job.name, job.handler)

  const routes = new Map(config.jobs.map(j => [j.name, j.queue]))
  const consumers = new Map<string, Consumer>()
  const id = randomUUID().slice(0, 8)
  const startedAt = Date.now()

  let state: SupervisorState = 'starting'
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  const supervisor: Supervisor = {
    id,
    driver,
    routes,
    consumers,
    config,

    getState: () => state,
    setState: (next) => { state = next },

    record: () => ({
      id,
      hostname: hostname(),
      pid: process.pid,
      role: config.role === 'web' ? 'both' : config.role,
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
      if (config.role !== 'web') {
        for (const [queue, concurrency] of Object.entries(config.worker.queues)) {
          consumers.set(queue, driver.consume(queue, { concurrency }))
        }

        heartbeatTimer = setInterval(() => {
          void driver.heartbeat(supervisor.record(), config.worker.heartbeatTtl)
            .catch(error => logger.debug('heartbeat failed', error))
        }, config.worker.heartbeatInterval)

        // Beat once immediately so a worker is visible before the first interval.
        await driver.heartbeat(supervisor.record(), config.worker.heartbeatTtl).catch(() => {})
      }

      state = 'running'
    },

    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
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
