import { defineEventHandler, getRouterParam, getQuery, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import type { JobState } from '../../drivers/types'

const STATES: JobState[] = ['waiting', 'active', 'completed', 'failed', 'delayed']

/**
 * Bounded so a hand-crafted `limit=1000000` cannot make the dev server hang.
 * Also load-bearing for the bullmq driver: `introspect.list()` deliberately
 * over-fetches (it must fetch `offset + limit` rows per job-state type, then
 * slice locally, because BullMQ's Lua applies the same range to each type
 * independently) and its comment justifies that over-fetch by asserting
 * `limit` is capped at 100. This clamp is the only place in the codebase that
 * makes that assertion true.
 */
const MAX_LIMIT = 100

export default defineEventHandler(async (event) => {
  const supervisor = getSupervisor()
  // `supervisor` is checked on its own rather than via `supervisor?.driver`,
  // because narrowing `introspect` does not narrow `supervisor` — and the queue
  // validation below reads `supervisor.config`.
  if (!supervisor?.driver.introspect) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support introspection' }
  }
  const introspect = supervisor.driver.introspect

  const queue = getRouterParam(event, 'queue')
  if (!queue || !(queue in supervisor.config.worker.queues)) {
    setResponseStatus(event, 404)
    return { error: `unknown queue "${queue}"` }
  }

  const query = getQuery(event)
  const state = String(query.state ?? 'failed') as JobState
  if (!STATES.includes(state)) {
    setResponseStatus(event, 400)
    return { error: `unknown state "${state}"; expected one of: ${STATES.join(' | ')}` }
  }

  // `|| 0` / `|| 25` fall back to the default when `Number(...)` produces
  // NaN (a non-numeric query value, e.g. `?limit=banana`) — NaN survives
  // Math.max/Math.min untouched, so without this a non-numeric limit would
  // NOT be clamped to MAX_LIMIT at all.
  const offset = Math.max(0, Number(query.offset ?? 0) || 0)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit ?? 25) || 25))

  return introspect.list(queue, state, { offset, limit })
})
