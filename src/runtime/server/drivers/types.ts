import type { ActiveJob, JobHandler, WorkerRecord } from '../types'

export interface DriverCapabilities {
  /** Survives process restart. */
  persistent: boolean
  /** A process that runs no workers can still read this driver's data. */
  crossProcess: boolean
}

export interface EnqueueOptions {
  name: string
  payload: unknown
  delay?: number
}

export interface ConsumeOptions {
  concurrency: number
}

export interface Consumer {
  /**
   * Stop fetching new jobs. MUST resolve immediately and MUST NOT await active
   * jobs — the shutdown budget does not start counting until this resolves, so
   * a blocking pause() spends the entire budget before the drain begins.
   */
  pause: () => Promise<void>
  /** Resolves when in-flight reaches zero. */
  drain: () => Promise<void>
  close: (force: boolean) => Promise<void>
  activeCount: () => number
  active: () => ActiveJob[]
}

export interface ConciergeDriver {
  readonly name: string
  readonly capabilities: DriverCapabilities

  init: () => Promise<void>
  close: (force: boolean) => Promise<void>

  /**
   * Whether the driver's underlying connection is currently healthy. `init()`
   * deliberately does not block on connectivity (ioredis reconnects by
   * design, and blocking boot on a transient blip would be worse), so this is
   * what lets the health endpoint refuse to report "running" while a worker's
   * connection is actually down — instead of a dead-Redis worker reporting
   * itself healthy and being promoted by a rolling deploy. The in-process
   * drivers (sync, memory) have no connection to lose and always report
   * healthy.
   */
  isHealthy: () => boolean

  /** Associates a handler with a queue+name. Called at boot for every scanned job. */
  registerHandler: (queue: string, name: string, handler: JobHandler) => void

  enqueue: (queue: string, job: EnqueueOptions) => Promise<{ id: string }>
  consume: (queue: string, opts: ConsumeOptions, onJob?: JobHandler) => Consumer
  /**
   * The number of jobs on `queue` that are due now and not yet started —
   * never jobs scheduled for later (e.g. a delayed/scheduled state). The
   * no-worker watch in guardrails.ts relies on this: counting not-yet-due
   * work would fire false alarms on queues that are merely scheduled ahead,
   * not actually stuck.
   */
  depth: (queue: string) => Promise<number>

  heartbeat: (record: WorkerRecord, ttlMs: number) => Promise<void>
  deregister: (id: string) => Promise<void>
  workers: () => Promise<WorkerRecord[]>
}
