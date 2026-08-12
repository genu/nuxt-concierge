import { defineEventHandler, setResponseStatus } from 'h3'
import { getSupervisor } from '../supervisor'

const ALLOWED_PREFIX = '/_concierge/health'

/**
 * True for the health route itself and any sub-path of it (e.g. a future
 * `/_concierge/health/live`), regardless of a trailing slash or query
 * string. A plain `startsWith(ALLOWED_PREFIX)` would also match an unrelated
 * route that merely shares the prefix (e.g. `/_concierge/healthcheck`) — this
 * is the one route that must never be accidentally shut off under
 * `role: worker`, so the match is exact-or-boundary rather than loose.
 */
const isHealthPath = (path: string): boolean =>
  path === ALLOWED_PREFIX
  || path.startsWith(`${ALLOWED_PREFIX}/`)
  || path.startsWith(`${ALLOWED_PREFIX}?`)

/**
 * Under role: worker, serve only the health route.
 *
 * Two reasons. It makes the process's job unambiguous, so a misconfigured load
 * balancer cannot send real traffic to a worker. And it is load-bearing for the
 * drain: Nitro closes HTTP connections and waits for them BEFORE calling close
 * hooks, so a worker with no long-lived connections reaches the drain in about
 * one poll interval instead of being starved by an open stream.
 */
export default defineEventHandler((event) => {
  const supervisor = getSupervisor()
  if (supervisor?.config.role !== 'worker') return
  if (isHealthPath(event.path ?? '')) return

  setResponseStatus(event, 503)
  return { error: 'This process runs with CONCIERGE_ROLE=worker and does not serve application routes.' }
})
