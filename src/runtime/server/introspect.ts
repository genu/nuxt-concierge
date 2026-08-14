import { decodePayload } from './envelope'
import type { Supervisor } from './supervisor'
import type { DriverCapabilities, JobDetail, QueueCounts } from './drivers/types'

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
 * than ever letting the panel catch up. This is short enough to keep
 * `/overview` responsive and generous enough for a normal (non-outage) read.
 */
const DRIVER_READ_TIMEOUT_MS = 1_500

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
 * Resolves to `undefined` on timeout rather than rejecting: a timed-out read
 * is not an application error to propagate, it is exactly the "unknown right
 * now" case `counts`/`workers` already represent with `undefined`/`[]`, and
 * `driverHealthy` (read separately, synchronously, off the driver's own
 * connection-state flag) is what carries the truth about *why*.
 */
const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout>
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
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

  const queues = await Promise.all(names.map(async name => ({
    name,
    concurrency: config.worker.queues[name]!,
    // Undefined, not zeroes: a driver with no introspection has UNKNOWN
    // counts, and zeroes would have the UI render a confident empty table.
    // Also undefined on a timed-out read — same UI treatment as "the driver
    // cannot answer this", which is true either way.
    counts: introspect ? await withTimeout(introspect.counts(name), readTimeoutMs) : undefined,
  })))

  const now = Date.now()
  // `?? []`, not left as `undefined`: a timed-out worker read must not crash
  // `.map()` below, and an empty worker list is the honest answer to "who do
  // we know about right now" when the read that would tell us is hanging.
  const records = await withTimeout(driver.workers(), readTimeoutMs) ?? []

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
