import type { ActiveJob, BackoffOptions, JobHandler, WorkerRecord } from '../types'

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
  /**
   * TOTAL attempts including the first, matching BullMQ's own semantics
   * (`shouldRetryJob` tests `attemptsMade + 1 < opts.attempts`, with
   * `attemptsMade` at 0 on the first failure). A driver must never translate
   * between "attempts" and "retries" — that conversion is where an
   * off-by-one hides, and `memory` and `bullmq` are required to agree
   * exactly (see test/unit/retry-conformance.test.ts).
   *
   * Undefined means "the caller did not resolve a value", not "one attempt".
   * `useQueue` always resolves it from the job or `concierge.defaults`, so a
   * driver receiving `undefined` should fall back to its own single-attempt
   * behaviour rather than inventing a default.
   *
   * `sync` ignores this field: it executes inline so errors propagate to the
   * `enqueue` caller, and retrying would swallow exactly what it exists to
   * expose.
   */
  attempts?: number
  /**
   * Delay for the k-th retry is `Math.round(2 ** (k - 1) * delay)` for
   * `exponential` and `delay` for `fixed`, matching BullMQ's built-in
   * strategies.
   */
  backoff?: BackoffOptions
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
