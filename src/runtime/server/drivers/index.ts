import type { DriverName } from '../../../options'
import { createSyncDriver } from './sync'
import type { ConciergeDriver } from './types'

export type * from './types'

export type ResolvedDriverName = Exclude<DriverName, 'auto'>

export interface ResolveDriverInput {
  configured: DriverName
  hasConnection: boolean
  isProduction: boolean
}

/**
 * `auto` is the zero-config adoption lever, not a production portability
 * feature. It must not silently fall back to `memory` in production: the prod
 * role default is `web`, and the crossProcess guardrail would then throw a
 * capability error that hides the real problem (a missing connection URL).
 */
export const resolveDriverName = (
  { configured, hasConnection, isProduction }: ResolveDriverInput,
): ResolvedDriverName => {
  if (configured !== 'auto') return configured
  if (hasConnection) return 'bullmq'

  if (isProduction) {
    throw new Error(
      '[nuxt-concierge] driver is "auto" but no connection URL was found in production. '
      + 'Set REDIS_URL (or concierge.connection), or choose a driver explicitly with concierge.driver.',
    )
  }

  return 'memory'
}

export interface CreateDriverOptions {
  connection?: { url?: string, host?: string, port?: number, password?: string }
  bullmq?: { maxStalledCount: number, stalledInterval: number }
}

export const createDriver = async (
  name: ResolvedDriverName,
  opts: CreateDriverOptions = {},
): Promise<ConciergeDriver> => {
  switch (name) {
    case 'sync':
      return createSyncDriver()
    case 'memory': {
      const { createMemoryDriver } = await import('./memory')
      return createMemoryDriver()
    }
    case 'bullmq': {
      const { createBullmqDriver } = await import('./bullmq')
      return createBullmqDriver(opts)
    }
  }
}
