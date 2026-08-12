// Stub — Task 8 replaces this file with the real supervisor.
import type { ConciergeDriver } from './drivers'

export const getDriver = (): { driver: ConciergeDriver, routes: Map<string, string> } => {
  throw new Error('[nuxt-concierge] the supervisor has not started yet')
}
