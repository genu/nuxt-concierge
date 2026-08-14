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

export const buildOverview = async (supervisor: Supervisor | undefined): Promise<OverviewResponse> => {
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
    // Undefined, not zeroes: a driver with no introspection has UNKNOWN counts,
    // and zeroes would have the UI render a confident empty table.
    counts: introspect ? await introspect.counts(name) : undefined,
  })))

  const now = Date.now()
  const records = await driver.workers()

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
