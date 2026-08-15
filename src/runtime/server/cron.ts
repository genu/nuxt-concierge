// DEFAULT IMPORT, NOT NAMED. cron-parser 4.9.0 is CommonJS with no `exports`
// map, and this package is `type: module` — `import { parseExpression } from
// 'cron-parser'` throws `SyntaxError: Named export 'parseExpression' not
// found` at runtime, which no typecheck catches. BullMQ's own ESM source uses
// the named form and gets away with it only because Node resolves BullMQ's CJS
// build. Verified by direct execution; do not "tidy" this back.
import cronParser from 'cron-parser'
import { consola } from 'consola'
import type { AnyJobDefinition, BackoffOptions, CronSpec } from './types'
import type { DriverScheduling, ScheduleSpec, ScheduleSummary } from './drivers/types'
import { formatIssuePath } from './validate'
import type { JobDefaults } from '../../options'

const { parseExpression } = cronParser

/** Exported so tests can spy on it instead of asserting on console output. */
export const logger = consola.create({}).withTag('nuxt-concierge')

export const CRON_DEFAULT_TZ = 'UTC'

/**
 * Every scheduler this module installs is namespaced. The sweep removes only
 * ids carrying this prefix, so adopting concierge on a queue that already has
 * unrelated BullMQ repeatable jobs does not delete them.
 */
export const CONCIERGE_SCHEDULE_PREFIX = 'concierge:'

export const schedulerIdFor = (jobName: string): string =>
  `${CONCIERGE_SCHEDULE_PREFIX}${jobName}`

export type CronInput = string | { expression: string, tz?: string, payload?: unknown }

/**
 * Normalises the string shorthand and the object form into one shape, and
 * fails loudly on a bad expression or zone.
 *
 * Validation happens HERE, at resolution, rather than at first fire: a
 * `defineJob` with a typo'd expression should be a boot error, not a schedule
 * that silently never runs. That is the v1 cron failure mode this spec exists
 * to not repeat.
 */
export const resolveCron = (input: CronInput): CronSpec => {
  const spec: CronSpec = typeof input === 'string'
    ? { expression: input, tz: CRON_DEFAULT_TZ }
    : { expression: input.expression, tz: input.tz ?? CRON_DEFAULT_TZ, payload: input.payload }

  try {
    // Parsing is the only real validation available for either field.
    parseExpression(spec.expression, { currentDate: new Date(0), tz: spec.tz })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The zone and the expression fail through the same call, so the message
    // is disambiguated by testing the zone independently — otherwise a bad
    // timezone reports as "not a valid cron expression", which sends the
    // reader to the wrong half of their config.
    if (!isValidTimeZone(spec.tz)) {
      throw new Error(
        `[nuxt-concierge] "${spec.tz}" is not a valid IANA timezone.`,
        { cause: error },
      )
    }
    throw new Error(
      `[nuxt-concierge] "${spec.expression}" is not a valid cron expression: ${message}`,
      { cause: error },
    )
  }

  return spec
}

const isValidTimeZone = (tz: string): boolean => {
  try {
    // Intl throws RangeError on an unknown zone. Cheaper and more accurate
    // than carrying a zone list that goes stale with every tzdata release.
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  }
  catch {
    return false
  }
}

/**
 * The next fire time strictly after `after`, in milliseconds.
 *
 * `cron-parser` is the single source of schedule arithmetic for BOTH drivers —
 * `bullmq` because its own `defaultRepeatStrategy` uses this exact library and
 * version, `memory` because it calls this function. A second implementation
 * (or a second library, e.g. the `croner` that Nitro drags in) would be a
 * conformance divergence between the driver developers see and the one they
 * deploy, which is the single most expensive class of bug in this project's
 * history.
 */
export const nextFireTime = (expression: string, tz: string, after: number): number =>
  parseExpression(expression, { currentDate: new Date(after), tz }).next().getTime()

export interface ReconciliationPlan {
  upserts: ScheduleSpec[]
  removals: string[]
}

export interface PlanReconciliationArgs {
  /** Every schedule declared for ONE queue. Empty when cron is disabled. */
  declared: ScheduleSpec[]
  /** Every scheduler the driver currently reports for that same queue. */
  existing: ScheduleSummary[]
}

/**
 * Pure set arithmetic, deliberately separated from every driver so the sweep's
 * correctness is testable without Redis, a timer, or a mock.
 *
 * Declared schedules are ALWAYS upserted, including ones that already exist:
 * upsert is idempotent and updates in place, so a changed expression needs no
 * removal — and doing it as remove-then-add would open a window in which the
 * schedule does not exist at all.
 */
export const planReconciliation = (
  { declared, existing }: PlanReconciliationArgs,
): ReconciliationPlan => {
  const declaredIds = new Set(declared.map(s => s.id))

  return {
    upserts: declared,
    removals: existing
      // Ownership check FIRST. Without it, an app adopting concierge on a
      // queue that already carries unrelated repeatable jobs would delete
      // them on its first boot.
      .filter(s => s.id.startsWith(CONCIERGE_SCHEDULE_PREFIX))
      .filter(s => !declaredIds.has(s.id))
      .map(s => s.id),
  }
}

/**
 * Boot-time check that every scheduled job's STATIC payload satisfies its own
 * `input` schema.
 *
 * Build time cannot do this: spec 3 established that validation requires
 * EXECUTING a schema, which is exactly why AST extraction was dropped rather
 * than deferred. Boot can, because the schema is a live object by then.
 *
 * The failure this prevents is nasty and silent-adjacent: consumer-side
 * validation throws `JobPayloadInvalidError` with `retryable = false`, so both
 * drivers classify it as PERMANENT. A schema-violating cron payload therefore
 * dead-letters on every single tick, forever, and the failed job says nothing
 * about a schedule being the cause.
 *
 * A startup error, consistent with how `resolveRole` and
 * `validateHistoryLimit` already treat config mistakes.
 */
export const validateCronPayloads = async (jobs: AnyJobDefinition[]): Promise<void> => {
  for (const job of jobs) {
    if (!job.cron || !job.input) continue

    const result = await job.input['~standard'].validate(job.cron.payload)
    if (!result.issues) continue

    // Issue MESSAGES are included here, unlike `validateOnConsume`'s. This
    // text goes to the boot log of the process the developer is starting, from
    // a payload written in their own source file — it never reaches the queue
    // backend and carries no user data. Withholding detail here would just
    // make a boot failure harder to fix.
    const detail = result.issues
      .map(issue => `${formatIssuePath(issue)}: ${issue.message}`)
      .join('; ')

    throw new Error(
      `[nuxt-concierge] the cron payload for job "${job.name}" does not satisfy its own input `
      + `schema — ${detail}. A scheduled job whose payload fails validation dead-letters on `
      + `every tick, because payload validation failures are permanent by design.`,
    )
  }
}

export interface ReconcileArgs {
  schedule: DriverScheduling
  /** Every scanned job. The full set, never this instance's subset. */
  jobs: Array<{ name: string, queue: string, cron?: CronSpec, attempts?: number, backoff?: BackoffOptions }>
  /** The queues this instance declares. */
  queues: string[]
  enabled: boolean
  /**
   * Fallback for a job that declares neither `attempts` nor `backoff` of its
   * own — the exact same fallback `useQueue().enqueue` applies to a manual
   * enqueue of that job, so a scheduler-produced tick and a dashboard
   * "Run now" of the same job share one retry policy, rather than the tick
   * silently getting none at all.
   */
  defaults: JobDefaults
}

/**
 * Upsert every declared schedule, then remove every concierge-owned scheduler
 * that is no longer declared — per queue, at boot, with no coordination
 * between instances.
 *
 * No leader election is needed because tick-uniqueness is a DRIVER guarantee:
 * `bullmq` keeps one delayed job in flight per scheduler, atomically in Lua,
 * and `memory` is single-process. A leader would be solving that problem a
 * second time.
 *
 * The accepted cost: during a rolling deploy that changes or removes a `cron`
 * key, old and new code disagree for the deploy window, so a schedule can miss
 * at most ONE tick. The prune is idempotent and convergent — a wrong prune
 * self-heals on the next boot.
 *
 * The declared set is computed from the FULL scanned job list, not from the
 * jobs this instance happens to handle. An instance whose `worker.queues` has
 * been narrowed sweeps only its own queues, which is self-consistent — but it
 * means at least one running instance must declare the full queue set, or
 * schedules on the undeclared queues are never reconciled at all.
 */
export const reconcileSchedules = async (
  { schedule, jobs, queues, enabled, defaults }: ReconcileArgs,
): Promise<void> => {
  for (const queue of queues) {
    // Isolated PER QUEUE, not just at the supervisor's outer call site. Parked
    // once on the reasoning that per-queue isolation "would add a partial-
    // success state harder to reason about" — but partial success is already
    // reachable here (every upsert runs before any remove), and a PERSISTENT
    // per-queue error (a bad ACL rule, a corrupted key type) means every queue
    // after this one in `queues` is never reconciled on ANY boot, not just
    // this one. That is exactly the failure the spec calls worse than a
    // missed tick when it rejects version-gating the prune: "A missed tick is
    // visible; a schedule that quietly stops being reconciled is not." A
    // transient failure still self-heals on the next boot, same as before.
    try {
      const declared: ScheduleSpec[] = enabled
        ? jobs
            .filter(job => job.cron && job.queue === queue)
            .map(job => ({
              id: schedulerIdFor(job.name),
              jobName: job.name,
              expression: job.cron!.expression,
              tz: job.cron!.tz,
              payload: job.cron!.payload,
              // Resolved HERE, not left for the driver to default: see the
              // `attempts` doc comment on ScheduleSpec for why an unresolved
              // value silently strips a scheduled job's retry policy.
              attempts: job.attempts ?? defaults.attempts,
              backoff: job.backoff ?? defaults.backoff,
            }))
        // Disabled runs the sweep with an EMPTY declared set rather than
        // skipping it, so "off" means off in Redis rather than merely off in
        // this process.
        : []

      const { upserts, removals } = planReconciliation({
        declared,
        existing: await schedule.list(queue),
      })

      for (const spec of upserts) await schedule.upsert(queue, spec)
      for (const id of removals) await schedule.remove(queue, id)
    }
    catch (error) {
      logger.warn(`[nuxt-concierge] schedule reconciliation failed for queue "${queue}"`, error)
    }
  }
}
