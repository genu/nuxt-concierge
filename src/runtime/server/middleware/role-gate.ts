import { defineEventHandler, setResponseStatus } from 'h3'
import { consola } from 'consola'
import { useRuntimeConfig } from '#imports'
import { resolveRole } from '../role'
import type { Role } from '../types'

const logger = consola.create({}).withTag('nuxt-concierge')

const ALLOWED_PREFIX = '/_concierge/health'

/**
 * True only for the health route itself — with or without a trailing slash,
 * with or without a query string — and never for a deeper sub-path
 * (`/_concierge/health/sub`) or an unrelated route that merely shares the
 * string prefix (`/_concierge/healthz`). This is the one route that must
 * never be accidentally shut off under `role: worker`, so the match is
 * exact-after-stripping-query rather than a loose `startsWith`.
 */
export const isHealthPath = (path: string | undefined): boolean => {
  if (!path) return false
  const withoutQuery = path.split('?')[0]
  return withoutQuery === ALLOWED_PREFIX || withoutQuery === `${ALLOWED_PREFIX}/`
}

export interface ResolveGateRoleInput {
  env: string | undefined
  config: string | undefined
  isDev: boolean
}

/**
 * Resolves the role exactly the way the generated plugin does at boot —
 * NEVER by reading it off the supervisor. `getSupervisor()?.config.role` is
 * `undefined` for the entire pre-boot window: `createSupervisor` awaits real
 * network I/O (`createDriver`, `driver.init()`), and the generated plugin
 * deliberately does not block the HTTP listener while that happens. Deriving
 * role from the supervisor would therefore fail OPEN on every boot of a
 * `role: worker` process — listener up, supervisor not yet set, gate
 * no-ops, application routes served by a process whose entire purpose is not
 * to serve them. The role itself has no such dependency: it is knowable
 * immediately from the env var and the build-time runtimeConfig default, so
 * that is what this reads instead.
 *
 * `resolveRole()` throws on an invalid value. That should already be
 * impossible by the time requests arrive — the generated plugin validates
 * the same inputs at boot and exits fatally on a bad role — but a throw per
 * request here would still be the wrong failure mode. A failure here returns
 * `undefined`, and the caller (`shouldRefuse`) treats an unresolved role as
 * fail-CLOSED (refuse non-health routes), not fail-open.
 */
export const resolveGateRole = ({ env, config, isDev }: ResolveGateRoleInput): Role | undefined => {
  try {
    return resolveRole({ env, config, isDev })
  }
  catch {
    return undefined
  }
}

/**
 * The gating decision itself, independent of h3/nitro so it can be tested
 * directly: `web` and `both` always pass every route. `worker`, and an
 * unresolved role (the fail-closed default), both restrict to the health
 * route only.
 */
export const shouldRefuse = (role: Role | undefined, path: string | undefined): boolean => {
  if (role === 'web' || role === 'both') return false
  return !isHealthPath(path)
}

let warnedOnce = false

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
  const config = useRuntimeConfig().concierge
  const role = resolveGateRole({ env: process.env.CONCIERGE_ROLE, config: config.role, isDev: config.isDev })

  if (role === undefined && !warnedOnce) {
    warnedOnce = true
    logger.error(
      '[nuxt-concierge] role-gate could not resolve the process role; refusing all non-health routes as a fail-closed default',
    )
  }

  if (!shouldRefuse(role, event.path)) return

  setResponseStatus(event, 503)
  return { error: 'This process runs with CONCIERGE_ROLE=worker and does not serve application routes.' }
})
