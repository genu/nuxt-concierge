import { Queue, UnrecoverableError, Worker } from 'bullmq'
import type { Job, JobType } from 'bullmq'
import { Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'
import { consola } from 'consola'
import { decodePayload, encodePayload } from '../envelope'
import type { ActiveJob, JobHandler, WorkerRecord } from '../types'
import type { BullmqOptions } from '../../../options'
import type { ConciergeDriver, Consumer, JobState, JobSummary } from './types'
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
 * ioredis's own options type, NOT `ConstructorParameters<typeof Redis>[0]`.
 * `Redis` has eight constructor overloads and `ConstructorParameters` picks
 * the LAST one, which takes no arguments — so that alias resolved to `[]`,
 * index 0 was a TS2493 error, and the alias silently became `undefined`.
 * Every cast through it therefore became `as undefined`, which is how one bad
 * type alias produced seven of the twelve pre-existing typecheck errors.
 *
 * BullMQ's own `ConnectionOptions` is a union that already includes this type
 * (`bullmq/dist/esm/interfaces/redis-options.d.ts`), so the same type serves
 * both the `new Redis(...)` and the `{ connection }` call sites below.
 */
type RedisConnectionOptions = RedisOptions

/** Mirrors moduleDefaults.bullmq in src/options.ts. */
const BULLMQ_DEFAULTS: BullmqOptions = { maxStalledCount: 3, stalledInterval: 30_000 }

/**
 * Merges field-by-field rather than `opts ?? defaults`, so a caller who only
 * overrides one field (e.g. `{ maxStalledCount: 5 }`) still gets the default
 * for the other rather than `undefined`.
 */
export const resolveBullmqOptions = (opts?: Partial<BullmqOptions>): BullmqOptions => ({
  maxStalledCount: opts?.maxStalledCount ?? BULLMQ_DEFAULTS.maxStalledCount,
  stalledInterval: opts?.stalledInterval ?? BULLMQ_DEFAULTS.stalledInterval,
})

/**
 * Mirrors the `retryable === false` branch in memory.ts. Kept as a small pure
 * function so it is unit-testable without a live Redis and so the processor
 * below stays a one-line decision.
 */
export const isPermanentFailure = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { retryable?: unknown }).retryable === false

/**
 * Tracks whether the driver's Redis connection(s) are currently healthy.
 * Factored out as a tiny state machine, independent of any real ioredis/
 * BullMQ instance, so its transitions are unit-testable without a live Redis
 * connection: `onError`/`onReady` are exactly the callbacks wired to the
 * shared client's and each Worker's own `error`/`ready` events below.
 *
 * `init()` deliberately does not block on connectivity — ioredis reconnects
 * by design, so blocking boot on a transient blip would be worse than
 * letting it settle in the background. This is what lets the health
 * endpoint, not boot, be the thing that refuses to report "running" while a
 * connection is actually down.
 */
export const createConnectionHealth = () => {
  let healthy = true
  return {
    isHealthy: () => healthy,
    onError: () => { healthy = false },
    onReady: () => { healthy = true },
  }
}

/**
 * BullMQ state name -> canonical JobState, or `undefined` for a state outside
 * the canonical five.
 *
 * `prioritized` folds into `waiting` to agree with `depth()`, which already
 * counts it as due work — a disagreement would make a job visible to the
 * no-worker guardrail and invisible in the dashboard. `paused` and
 * `waiting-children` return `undefined` rather than being folded anywhere:
 * inventing a mapping would have the dashboard claim something false, and the
 * caller filters them out.
 */
export const bullStateToJobState = (state: string): JobState | undefined => {
  switch (state) {
    case 'wait':
    case 'waiting':
    case 'prioritized':
      return 'waiting'
    case 'active': return 'active'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'delayed': return 'delayed'
    default: return undefined
  }
}

/** BullMQ's own job states for the canonical five, for `getJobs` queries. */
const BULL_STATES: Record<JobState, JobType[]> = {
  waiting: ['wait', 'prioritized'],
  active: ['active'],
  completed: ['completed'],
  failed: ['failed'],
  delayed: ['delayed'],
}

/**
 * Projects a BullMQ job onto JobSummary. Exported and pure so the mapping is
 * testable without a live Redis — the round trip is covered by the shared
 * conformance table, which does need one.
 */
export const jobToSummary = (job: Job, queue: string, state: JobState): JobSummary => ({
  // String, because BullMQ ids are numeric and JobSummary.id is a string
  // across every driver. A numeric id would make a strict `get` comparison miss.
  id: String(job.id),
  name: job.name,
  queue,
  state,
  attemptsMade: job.attemptsMade,
  attempts: job.opts?.attempts,
  createdAt: job.timestamp,
  // undefined rather than 0: a 0 renders as the epoch, which reads as a real
  // timestamp rather than an absent one.
  finishedAt: job.finishedOn ?? undefined,
  failedReason: job.failedReason ?? undefined,
})

export const createBullmqDriver = (opts: CreateDriverOptions = {}): ConciergeDriver => {
  const connection = buildConnection(opts.connection)
  const bull = resolveBullmqOptions(opts.bullmq)

  const queues = new Map<string, Queue>()
  const handlers = new Map<string, JobHandler>()
  const workers: Worker[] = []
  let redis: Redis | undefined
  const health = createConnectionHealth()

  const key = (queue: string, name: string) => `${queue}::${name}`

  const client = () => {
    if (!redis) {
      redis = 'url' in connection
        ? new Redis(connection.url, { maxRetriesPerRequest: null })
        : new Redis({ ...connection, maxRetriesPerRequest: null } as RedisConnectionOptions)
      redis.on('error', (err) => {
        health.onError()
        logger.error('[nuxt-concierge] redis connection error', err)
      })
      redis.on('ready', health.onReady)
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
    capabilities: { persistent: true, crossProcess: true, history: 'durable' },

    introspect: {
      counts: async (queue) => {
        const c = await queueOf(queue).getJobCounts(
          'wait', 'prioritized', 'active', 'completed', 'failed', 'delayed',
        )
        return {
          // wait + prioritized, matching both depth() and
          // bullStateToJobState. Omitting prioritized would undercount, since
          // BullMQ 5 puts explicitly-prioritised jobs in their own state.
          waiting: (c.wait ?? 0) + (c.prioritized ?? 0),
          active: c.active ?? 0,
          completed: c.completed ?? 0,
          failed: c.failed ?? 0,
          delayed: c.delayed ?? 0,
        }
      },

      list: async (queue, state, page) => {
        const q = queueOf(queue)
        const types = BULL_STATES[state]
        const [jobs, total] = await Promise.all([
          // BullMQ's getJobs applies the SAME start/end range to EVERY type
          // key independently (getRanges-1.lua does one LRANGE/ZRANGE per
          // key, then concatenates) rather than treating `types` as one
          // globally-ordered, globally-paginated sequence. For `waiting`
          // (['wait', 'prioritized']) that means offset=0, limit=10 can
          // return up to 20 items — 10 from each key. Slicing the
          // concatenation locally, below, is what actually enforces
          // `page.limit`; the naive single getJobs call looks correct but
          // silently returns 2x for any state backed by more than one type.
          q.getJobs(types, page.offset, page.offset + page.limit - 1),
          q.getJobCountByTypes(...types),
        ])
        return {
          items: jobs.filter(Boolean)
            .map(j => jobToSummary(j, queue, state))
            .slice(0, page.limit),
          total,
        }
      },

      get: async (queue, id) => {
        const job = await queueOf(queue).getJob(id)
        if (!job) return undefined

        const bullState = await job.getState()
        const state = bullStateToJobState(bullState)
        // A job in `paused` or `waiting-children` has no canonical state, and
        // `getState()` can also return `unknown` (BullMQ's value when the job
        // is not found in any known set, e.g. removed concurrently with this
        // read). All three fall back to `waiting` ONLY here, in the detail
        // view, where `raw.bullState` carries the true value for display —
        // never in `list`, whose queries are keyed by canonical state.
        return {
          ...jobToSummary(job, queue, state ?? 'waiting'),
          envelope: job.data,
          stack: job.stacktrace?.join('\n') || undefined,
          raw: { bullState, opts: job.opts as Record<string, unknown> },
        }
      },

      retry: async (queue, id) => {
        const job = await queueOf(queue).getJob(id)
        if (!job) throw new Error(`[nuxt-concierge] no job "${id}" on queue "${queue}" to retry.`)
        await job.retry()
      },
    },

    init: async () => { client() },
    isHealthy: health.isHealthy,

    close: async (force) => {
      await Promise.allSettled([
        ...workers.splice(0).map(w => w.close(force)),
        ...[...queues.values()].map(q => q.close()),
      ])
      if (redis) {
        // quit() waits for the pending command queue to flush — the exact
        // opposite of what a force close wants — and it REJECTS when the
        // connection is already ended or in an error state, which is
        // precisely when this shutdown path is most likely to run (Redis
        // unreachable). An uncaught rejection here would skip `queues.clear()`
        // and `redis = undefined` below, so a force close uses disconnect()
        // (synchronous, cannot reject) and a graceful close catches quit()'s
        // rejection rather than letting it propagate.
        if (force) {
          redis.disconnect()
        }
        else {
          await redis.quit().catch((error: unknown) => {
            logger.error('[nuxt-concierge] redis.quit() failed while closing', error)
          })
        }
      }
      queues.clear()
      redis = undefined
    },

    registerHandler: (queue, name, handler) => { handlers.set(key(queue, name), handler) },

    enqueue: async (queue, job) => {
      const added = await queueOf(queue).add(job.name, encodePayload(job.payload), {
        delay: job.delay,
        // Straight through, no arithmetic: EnqueueOptions.attempts already
        // means what BullMQ's attempts means. Before this, nothing passed
        // attempts at all, BullMQ defaulted to 0, and `attemptsMade + 1 < 0`
        // is never true — so a failing job was never retried in production
        // while the memory driver retried it three times.
        attempts: job.attempts,
        backoff: job.backoff,
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
          catch (error) {
            // Retrying an undecodable payload (or any error explicitly marked
            // non-retryable) fails identically every time. UnrecoverableError
            // tells BullMQ to fail the job now instead of consuming/scheduling
            // a retry — the crash-loop this guards against only becomes
            // reachable once per-job `attempts` are configured, but the guard
            // is cheap to have in place before that happens.
            if (isPermanentFailure(error)) {
              throw new UnrecoverableError(error instanceof Error ? error.message : String(error))
            }
            throw error
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

      // A worker's Redis connection is independent of the shared `client()`
      // connection above (BullMQ gives each Worker its own), so it needs its
      // own error/ready wiring: this is the connection that actually matters
      // for "can this process process jobs", the exact failure the health
      // endpoint needs to catch.
      worker.on('error', (err) => {
        health.onError()
        logger.error(`[${queue}] worker error`, err)
      })
      worker.on('ready', health.onReady)

      workers.push(worker)

      return {
        // worker.pause(true) does NOT wait for active jobs, unlike pause().
        pause: async () => { await worker.pause(true) },

        drain: async () => {
          // unref'd so a never-settling handler (active.size staying > 0
          // forever) cannot hold the process open on its own once the
          // caller (runDrain) has already moved on past its own deadline —
          // only real in-flight work should keep the process alive.
          while (active.size > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 25)
              timer.unref?.()
            })
          }
        },

        close: async (force) => { await worker.close(force) },

        activeCount: () => active.size,
        active: () => [...active.values()],
      }
    },

    // Due-now-and-unstarted, matching the memory driver's `runAt <= Date.now()`
    // filter — not "everything not yet finished". `delayed` is deliberately
    // excluded: those jobs move into `wait` themselves once their delay
    // elapses, so counting them here would double-count the future and make
    // the no-worker watch (guardrails.ts) fire on queues that are only
    // scheduled ahead, not actually stuck. `prioritized` is included because
    // BullMQ 5 puts jobs with an explicit priority in their own state, not
    // `wait` — omitting it would undercount due work.
    depth: async (queue) => {
      const q = queueOf(queue)
      const [waiting, prioritized] = await Promise.all([q.getWaitingCount(), q.getPrioritizedCount()])
      return waiting + prioritized
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
