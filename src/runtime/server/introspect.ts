import { decodePayload } from './envelope'
import type { Supervisor } from './supervisor'
import type { DriverCapabilities, DriverIntrospection, JobDetail, JobState, JobSummary, QueueCounts } from './drivers/types'

/**
 * A decoded payload, or the reason it could not be decoded.
 *
 * Discriminated rather than a bare value so a decode failure renders as a
 * visible error. It must not render blank, and it must not fall back to showing
 * the raw envelope string — that would reintroduce exactly the payload-content
 * leak `decodePayload`'s shape-only error message exists to avoid.
 */
export type PayloadResult
  = { ok: true, value: unknown }
  | { ok: false, error: string }

export const decodeForDisplay = (envelope: unknown): PayloadResult => {
  try {
    return { ok: true, value: decodePayload(envelope) }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface WorkerView {
  id: string
  hostname: string
  pid: number
  role: string
  queues: string[]
  /**
   * Included deliberately, not an oversight: `WorkerRecord` already carries
   * this field and the `...r` spread below puts it on the wire whether or not
   * it is declared here. Declaring it is what lets the SPA type against what
   * actually arrives instead of reading an undeclared property off `unknown`
   * — the alternative (omitting it) doesn't hide the field, it just leaves
   * the wire shape and the type lying to each other.
   */
  concurrency: Record<string, number>
  version: string
  startedAt: number
  lastHeartbeat: number
  state: string
  active: unknown[]
  /**
   * Computed HERE, not in the client. The SPA renders flags; every derived
   * state lives server-side, which is the sole reason this spec ships no
   * client-side tests.
   */
  stale: boolean
}

export interface OverviewResponse {
  /** `absent` when there is no supervisor at all — never a SupervisorState. */
  state: 'starting' | 'running' | 'draining' | 'stopped' | 'absent'
  role: string
  driver: string
  driverHealthy: boolean
  capabilities: DriverCapabilities | undefined
  /** Whether the driver implements introspection at all. Presence is the capability. */
  introspectable: boolean
  version: string
  queues: Array<{ name: string, concurrency: number, counts?: QueueCounts }>
  workers: WorkerView[]
}

/**
 * A dev panel that polls every 2s does not need a driver read to ever take
 * longer than that to be useful — and a bound longer than the poll interval
 * would just stack concurrent requests once one starts running over, rather
 * than ever letting the panel catch up. This is short enough to keep every
 * dev-only introspection endpoint (`overview`, the jobs list/detail/retry
 * routes) responsive, and generous enough for a normal (non-outage) read.
 *
 * Shared across all of them rather than redeclared per route: it is the same
 * failure mode everywhere it's used (see `withTimeoutOrThrow` below), so it
 * gets one name and one value.
 */
export const DRIVER_READ_TIMEOUT_MS = 1_500

/**
 * Distinguishes "the read timed out" from any other rejection, and — just as
 * importantly — from a legitimate success value that happens to be
 * `undefined` (e.g. `introspect.get()` returning `undefined` for "no such
 * job"). A sentinel return value can't make that distinction; a dedicated
 * thrown type can.
 */
export class DriverReadTimeoutError extends Error {}

/**
 * Races a driver read against a fixed timeout so a fully unreachable backend
 * cannot hang the whole endpoint. This exists because of a real failure mode,
 * not a hypothetical one: BullMQ requires its ioredis connections to be
 * constructed with `maxRetriesPerRequest: null` (blocking commands need it),
 * which means a command issued while disconnected sits in ioredis's offline
 * queue forever — it never rejects on its own. Deliberately NOT solved by
 * checking `driver.isHealthy()` first and skipping the read: `isHealthy()` is
 * driven off ioredis's `error`/`ready` events, so a connection can still be
 * reported healthy while an individual command is hanging (e.g. a partial
 * outage, or a state transition in flight) — it is not a reliable gate on
 * its own. The timeout bounds the read regardless of what `isHealthy()` says.
 *
 * Throws `DriverReadTimeoutError` on timeout rather than resolving to a
 * sentinel — callers that want to degrade silently (`buildOverview`, via
 * `withTimeout` below) catch it themselves; callers that want to turn it into
 * a real HTTP error (the jobs list/detail/retry routes) let it propagate and
 * inspect it in their own catch, where a generic driver error and a timeout
 * must be told apart (a timeout is "unreachable right now", not "not found"
 * or "conflict").
 */
export const withTimeoutOrThrow = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DriverReadTimeoutError(message)), ms)
    // Never holds the process open on its own — this is a response-shaping
    // bound, not real work the process should wait to finish.
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timedOut])
  }
  finally {
    clearTimeout(timer!)
  }
}

/**
 * `buildOverview`'s own flavor: degrades to `undefined` on timeout instead of
 * throwing, because `counts`/`workers` already have an established "unknown
 * right now" representation (`undefined`/`[]`) and `driverHealthy` is what
 * carries the truth about *why* — there is no HTTP status to pick here the
 * way there is for a single-resource route.
 */
const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  try {
    return await withTimeoutOrThrow(promise, ms, 'driver read timed out')
  }
  catch (error) {
    if (error instanceof DriverReadTimeoutError) return undefined
    throw error
  }
}

export const buildOverview = async (
  supervisor: Supervisor | undefined,
  /** Overridable so tests can exercise the timeout path without a real wait. */
  readTimeoutMs: number = DRIVER_READ_TIMEOUT_MS,
): Promise<OverviewResponse> => {
  if (!supervisor) {
    return {
      state: 'absent',
      role: 'unknown',
      driver: 'none',
      driverHealthy: false,
      capabilities: undefined,
      introspectable: false,
      version: 'unknown',
      queues: [],
      workers: [],
    }
  }

  const { driver, config } = supervisor
  const introspect = driver.introspect
  const names = Object.keys(config.worker.queues)

  // The queue reads and the worker read are independent — run them
  // concurrently via one outer `Promise.all`, not one after the other. Each
  // is already bounded to `readTimeoutMs` on its own; awaiting them
  // sequentially would make the worst case under an outage additive (two
  // timeouts back to back) instead of capped at roughly one.
  const [queues, records] = await Promise.all([
    Promise.all(names.map(async name => ({
      name,
      concurrency: config.worker.queues[name]!,
      // Undefined, not zeroes: a driver with no introspection has UNKNOWN
      // counts, and zeroes would have the UI render a confident empty table.
      // Also undefined on a timed-out read — same UI treatment as "the driver
      // cannot answer this", which is true either way.
      counts: introspect ? await withTimeout(introspect.counts(name), readTimeoutMs) : undefined,
    }))),
    // `?? []`, not left as `undefined`: a timed-out worker read must not
    // crash `.map()` below, and an empty worker list is the honest answer to
    // "who do we know about right now" when the read that would tell us is
    // hanging.
    withTimeout(driver.workers(), readTimeoutMs).then(r => r ?? []),
  ])

  const now = Date.now()

  return {
    state: supervisor.getState(),
    role: config.role,
    driver: driver.name,
    driverHealthy: driver.isHealthy(),
    capabilities: driver.capabilities,
    introspectable: Boolean(introspect),
    version: config.version,
    queues,
    workers: records.map(r => ({
      ...r,
      stale: now - r.lastHeartbeat > config.worker.heartbeatTtl,
    })),
  }
}

/**
 * One message shape, shared by every route below and by `/overview`'s
 * cousins: names the driver and the bound, so a developer sees "the bullmq
 * driver did not respond within 1500ms — it may be unreachable" rather than a
 * generic "503 Service Unavailable" with no cause.
 */
const driverTimeoutMessage = (driverName: string, timeoutMs: number): string =>
  `the ${driverName} driver did not respond within ${timeoutMs}ms — it may be unreachable`

/**
 * The jobs list/detail/retry routes have the identical hang that `buildOverview`
 * had, over the identical cause (a dead-Redis bullmq connection queuing
 * commands forever): `introspect.list()`/`get()`/`retry()` call straight into
 * the driver with nothing bounding them. Unlike `buildOverview`, these three
 * are single-resource routes with a real HTTP status to pick, so each is a
 * thin, individually testable wrapper around `withTimeoutOrThrow` — a
 * timeout is not swallowed into `undefined` here, it propagates as
 * `DriverReadTimeoutError` for the route handler to turn into a 503.
 *
 * `JobsPanel`'s only other signal is `overview.introspectable`, which for
 * bullmq stays `true` throughout an outage (the driver still declares
 * introspection support, it just can't currently answer) — so without this,
 * a dead connection would present as a silently empty job list, not an
 * explained one.
 */
export const readJobsList = (
  introspect: DriverIntrospection,
  driverName: string,
  queue: string,
  state: JobState,
  page: { offset: number, limit: number },
  timeoutMs: number = DRIVER_READ_TIMEOUT_MS,
): Promise<{ items: JobSummary[], total: number }> =>
  withTimeoutOrThrow(introspect.list(queue, state, page), timeoutMs, driverTimeoutMessage(driverName, timeoutMs))

export const readJobDetail = (
  introspect: DriverIntrospection,
  driverName: string,
  queue: string,
  id: string,
  timeoutMs: number = DRIVER_READ_TIMEOUT_MS,
): Promise<JobDetail | undefined> =>
  withTimeoutOrThrow(introspect.get(queue, id), timeoutMs, driverTimeoutMessage(driverName, timeoutMs))

export const retryJob = (
  introspect: DriverIntrospection,
  driverName: string,
  queue: string,
  id: string,
  timeoutMs: number = DRIVER_READ_TIMEOUT_MS,
): Promise<void> =>
  withTimeoutOrThrow(introspect.retry(queue, id), timeoutMs, driverTimeoutMessage(driverName, timeoutMs))

export interface JobDetailResponse extends Omit<JobDetail, 'envelope'> {
  payload: PayloadResult
}

/**
 * Replaces the raw envelope with a decoded result. The envelope is DROPPED,
 * not carried alongside: keeping it would put a devalue string in front of
 * the user and hand the client a second, undecoded copy it could be tempted
 * to parse — which is how the decode path would end up duplicated in the SPA.
 */
export const toDetailResponse = (detail: JobDetail): JobDetailResponse => {
  const { envelope, ...rest } = detail
  return { ...rest, payload: decodeForDisplay(envelope) }
}

export type { JobDetail }
