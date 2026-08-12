import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { consola } from 'consola'
import { decodePayload, encodePayload } from '../envelope'
import type { ActiveJob, JobHandler, WorkerRecord } from '../types'
import type { ConciergeDriver, Consumer } from './types'
import type { CreateDriverOptions } from './index'

/** Matches memory.ts so log output from either driver is tagged the same way. */
const logger = consola.create({}).withTag('nuxt-concierge')

export const WORKER_KEY_PREFIX = 'concierge:workers:'
export const workerRecordKey = (id: string) => `${WORKER_KEY_PREFIX}${id}`

type Connection = { url: string } | { host: string, port: number, password?: string }

export const buildConnection = (c: CreateDriverOptions['connection'] = {}): Connection => {
  if (c.url) return { url: c.url }
  if (c.host) return { host: c.host, port: c.port ?? 6379, password: c.password }
  throw new Error(
    '[nuxt-concierge] the bullmq driver needs a connection. Set REDIS_URL or concierge.connection.',
  )
}

/**
 * BullMQ's `redisOptions` shape overlaps with, but is not identical to,
 * ioredis's constructor options. The connection we build here only ever
 * carries `url`/`host`/`port`/`password`, all of which are valid for both, so
 * the cast is narrow and safe rather than a blanket `any`.
 */
type RedisConnectionOptions = ConstructorParameters<typeof Redis>[0]

export const createBullmqDriver = (opts: CreateDriverOptions = {}): ConciergeDriver => {
  const connection = buildConnection(opts.connection)
  const bull = opts.bullmq ?? { maxStalledCount: 3, stalledInterval: 30_000 }

  const queues = new Map<string, Queue>()
  const handlers = new Map<string, JobHandler>()
  const workers: Worker[] = []
  let redis: Redis | undefined

  const key = (queue: string, name: string) => `${queue}::${name}`

  const client = () => {
    if (!redis) {
      redis = 'url' in connection
        ? new Redis(connection.url, { maxRetriesPerRequest: null })
        : new Redis({ ...connection, maxRetriesPerRequest: null } as RedisConnectionOptions)
    }
    return redis
  }

  const queueOf = (name: string) => {
    if (!queues.has(name)) {
      queues.set(name, new Queue(name, { connection: { ...connection } as RedisConnectionOptions }))
    }
    return queues.get(name)!
  }

  return {
    name: 'bullmq',
    capabilities: { persistent: true, crossProcess: true },

    init: async () => { client() },

    close: async (force) => {
      await Promise.allSettled([
        ...workers.splice(0).map(w => w.close(force)),
        ...[...queues.values()].map(q => q.close()),
      ])
      await redis?.quit()
      queues.clear()
      redis = undefined
    },

    registerHandler: (queue, name, handler) => { handlers.set(key(queue, name), handler) },

    enqueue: async (queue, job) => {
      const added = await queueOf(queue).add(job.name, encodePayload(job.payload), {
        delay: job.delay,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      })
      return { id: String(added.id) }
    },

    consume: (queue, consumeOpts, onJob): Consumer => {
      const active = new Map<string, ActiveJob>()

      const worker = new Worker(
        queue,
        async (job) => {
          const jobId = String(job.id)
          active.set(jobId, {
            jobId,
            queue,
            name: job.name,
            startedAt: job.processedOn ?? Date.now(),
          })
          try {
            const handler = onJob ?? handlers.get(key(queue, job.name))
            if (!handler) {
              throw new Error(`[nuxt-concierge] no handler for "${job.name}" on "${queue}"`)
            }
            await handler({
              id: jobId,
              name: job.name,
              queue,
              attempt: job.attemptsMade + 1,
              payload: decodePayload(job.data),
            })
          }
          finally {
            active.delete(jobId)
          }
        },
        {
          connection: { ...connection } as RedisConnectionOptions,
          concurrency: consumeOpts.concurrency,
          // BullMQ defaults to 1, which fails a job permanently after two
          // force-closes. Too aggressive for long jobs plus frequent deploys.
          maxStalledCount: bull.maxStalledCount,
          stalledInterval: bull.stalledInterval,
        },
      )

      worker.on('error', err => logger.error(`[${queue}] worker error`, err))

      workers.push(worker)

      return {
        // worker.pause(true) does NOT wait for active jobs, unlike pause().
        pause: async () => { await worker.pause(true) },

        drain: async () => {
          while (active.size > 0) await new Promise(r => setTimeout(r, 25))
        },

        close: async (force) => { await worker.close(force) },

        activeCount: () => active.size,
        active: () => [...active.values()],
      }
    },

    depth: async (queue) => {
      const q = queueOf(queue)
      const [waiting, delayed] = await Promise.all([q.getWaitingCount(), q.getDelayedCount()])
      return waiting + delayed
    },

    heartbeat: async (record, ttlMs) => {
      await client().set(
        workerRecordKey(record.id),
        JSON.stringify(record),
        'PX',
        ttlMs,
      )
    },

    deregister: async (id) => { await client().del(workerRecordKey(id)) },

    // Redis key expiry (PX above) gives registry TTL for free, so unlike the
    // memory driver, there is no expiry filtering to do on read.
    workers: async () => {
      const found: WorkerRecord[] = []
      let cursor = '0'
      do {
        const [next, keys] = await client().scan(cursor, 'MATCH', `${WORKER_KEY_PREFIX}*`, 'COUNT', 100)
        cursor = next
        if (keys.length) {
          const values = await client().mget(...keys)
          for (const v of values) {
            if (v) {
              try { found.push(JSON.parse(v) as WorkerRecord) }
              catch { /* a malformed record must not break the whole listing */ }
            }
          }
        }
      } while (cursor !== '0')
      return found
    },
  }
}
