// Stub — Task 6 replaces this file with the real BullMQ-backed driver.
import type { CreateDriverOptions } from './index'
import type { ConciergeDriver } from './types'

export const createBullmqDriver = (_opts: CreateDriverOptions = {}): ConciergeDriver => {
  throw new Error('[nuxt-concierge] bullmq driver not implemented yet')
}
