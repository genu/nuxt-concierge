import type { ActiveJob, BackoffOptions, JobHandler, WorkerRecord } from '../types'

export interface DriverCapabilities {
  /** Survives process restart. */
  persistent: boolean
  /** A process that runs no workers can still read this driver's data. */
  crossProcess: boolean
  /**
   * Whether terminal-state results survive, and for how long.
   *
   * The ONLY capability flag this SPI adds, because it is the only question
   * the presence of `introspect` cannot answer. "These results may have been
   * evicted" is information the dashboard must show, and `bounded` is not a
   * degraded `durable` — it changes what the UI is allowed to claim.
   */
  history: 'durable' | 'bounded' | 'none'
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

/**
 * The canonical job states, deliberately five members.
 *
 * BullMQ also has `paused`, `prioritized` and `waiting-children`. Admitting
 * them would make `memory` fabricate three states to satisfy a union shaped by
 * one driver's internals — which is exactly how `depth()` drifted in phase 1
 * before its contract was written down. Driver-specific state belongs in
 * `JobDetail.raw`, which the detail view may display and no code branches on.
 */
export type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'

export interface QueueCounts {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

export interface JobSummary {
  id: string
  name: string
  queue: string
  state: JobState
  /**
   * Attempts already MADE. Never translated to or from "retries" — that
   * conversion is where an off-by-one hides.
   */
  attemptsMade: number
  /** TOTAL attempts including the first, when the driver knows it. */
  attempts?: number
  createdAt: number
  finishedAt?: number
  failedReason?: string
}

export interface JobDetail extends JobSummary {
  /**
   * The RAW stored envelope, never a decoded payload.
   *
   * Decoding belongs to the API layer alone. `decodePayload` owns the
   * `v`-version check AND an error message that deliberately reports `typeof`
   * rather than content, because a payload routinely carries user data and the
   * message reaches both the queue backend and the log stream. Three driver
   * implementations of that path would be three chances to drift, and the
   * drift would be a privacy leak rather than a wrong number.
   */
  envelope: unknown
  stack?: string
  /** Driver-specific extras. Display-only; nothing branches on this. */
  raw?: Record<string, unknown>
}

export interface DriverIntrospection {
  counts: (queue: string) => Promise<QueueCounts>
  list: (
    queue: string,
    state: JobState,
    page: { offset: number, limit: number },
  ) => Promise<{ items: JobSummary[], total: number }>
  get: (queue: string, id: string) => Promise<JobDetail | undefined>
  /**
   * Re-queues a failed job. Throws if it is not currently `failed`.
   *
   * PRESERVES the recorded attempt count rather than resetting it. This
   * mirrors BullMQ's own `job.retry()`, which has no option to reset
   * `attemptsMade` (installed version 5.63.0: `retry(state?: FinishedStatus)`,
   * no `resetAttemptsMade`) — an exhausted job moved back to `waiting` runs
   * its handler exactly ONE more time and then dead-letters again, rather
   * than receiving a full fresh allowance of `attempts` runs. `bullmq` is the
   * reference for this behaviour and `memory` is required to match it exactly
   * (see the `attempts: 3` case in `introspection-conformance.test.ts`); a
   * driver that resets the count instead would let a UI-triggered retry run
   * far more times on one driver than another for the identical job.
   */
  retry: (queue: string, id: string) => Promise<void>
}

export interface ConciergeDriver {
  readonly name: string
  readonly capabilities: DriverCapabilities
  /**
   * Presence IS the capability. A driver either supports introspection or does
   * not, as a type-level fact.
   *
   * The rejected alternative — boolean flags on `capabilities` alongside
   * optional methods — permits a driver declaring support it lacks, or the
   * reverse, and typechecks fine. Same move spec 3 made giving
   * `validateOnEnqueue` a `void` return: make the inconsistent state
   * unrepresentable rather than merely untested.
   */
  readonly introspect?: DriverIntrospection

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
