import { defineEventHandler, getRouterParam, getQuery, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { DriverReadTimeoutError, readJobsList } from '../../introspect'
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
  //
  // `offset` deliberately has NO ceiling, unlike `limit`. That is only safe
  // because `bullmq.ts`'s `introspect.list()` always passes Redis range
  // START `0` (never `page.offset`) — see the "do not optimize the offset
  // back into the Redis range" comment there. A hand-crafted `offset=1e9`
  // still costs Redis roughly the queue's real size, not the offset value,
  // because the range start stays 0. If that invariant is ever "optimized"
  // away, `offset` needs a ceiling too — this comment exists so that change
  // does not land without one.
  const offset = Math.max(0, Number(query.offset ?? 0) || 0)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit ?? 25) || 25))

  try {
    // Bounded for the same reason `buildOverview` is: `introspect.list()`
    // runs over the same ioredis connection that queues commands forever
    // (`maxRetriesPerRequest: null`) against a fully unreachable Redis. Left
    // unbounded, this endpoint would hang exactly like `/overview` did — and
    // `JobsPanel`'s only other signal, `overview.introspectable`, stays
    // `true` for bullmq throughout an outage, so an unbounded read here would
    // present as an empty job list with no error, indistinguishable from
    // "there are genuinely no jobs".
    return await readJobsList(introspect, supervisor.driver.name, queue, state, { offset, limit })
  }
  catch (error) {
    if (error instanceof DriverReadTimeoutError) {
      // 503, not an empty `{ items: [], total: 0 }`: an empty list on
      // timeout is the exact "looks like there's nothing here" failure this
      // fix exists to eliminate. The client renders this against
      // `driverHealthy`, which is already `false` by the time a real outage
      // would trigger this branch.
      setResponseStatus(event, 503)
      return { error: error.message }
    }
    throw error
  }
})
