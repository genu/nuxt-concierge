import type { Role } from './types'

const ROLES: readonly Role[] = ['web', 'worker', 'both']

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

export interface ResolveRoleInput {
  env?: string
  config?: string
  isDev: boolean
}

/**
 * Precedence: CONCIERGE_ROLE env -> concierge.role config -> default.
 *
 * The default is `both` in dev and `web` in production: processing must be
 * opted into, so the failure mode is "jobs pile up" (loud, and caught by the
 * no-worker warning) rather than "every web instance also processes jobs"
 * (silent, and surfaces only as duplicate side effects).
 */
export const resolveRole = ({ env, config, isDev }: ResolveRoleInput): Role => {
  if (env) {
    if (!isRole(env)) {
      throw new Error(
        `[nuxt-concierge] CONCIERGE_ROLE is "${env}", which is not a valid role. Expected one of: web | worker | both`,
      )
    }
    return env
  }

  if (config) {
    if (!isRole(config)) {
      throw new Error(
        `[nuxt-concierge] concierge.role is "${config}", which is not a valid role. Expected one of: web | worker | both`,
      )
    }
    return config
  }

  return isDev ? 'both' : 'web'
}

export interface ResolveVersionInput {
  env?: string
  packageVersion?: string
}

/**
 * CONCIERGE_VERSION wins so CI can inject a git SHA into the deployed process,
 * then the host app's package.json version, then a placeholder.
 */
export const resolveVersion = ({ env, packageVersion }: ResolveVersionInput): string =>
  env?.trim() || packageVersion?.trim() || 'unknown'
