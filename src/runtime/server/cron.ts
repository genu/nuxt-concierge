// DEFAULT IMPORT, NOT NAMED. cron-parser 4.9.0 is CommonJS with no `exports`
// map, and this package is `type: module` — `import { parseExpression } from
// 'cron-parser'` throws `SyntaxError: Named export 'parseExpression' not
// found` at runtime, which no typecheck catches. BullMQ's own ESM source uses
// the named form and gets away with it only because Node resolves BullMQ's CJS
// build. Verified by direct execution; do not "tidy" this back.
import cronParser from 'cron-parser'
import type { CronSpec } from './types'
import type { ScheduleSpec, ScheduleSummary } from './drivers/types'

const { parseExpression } = cronParser

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
