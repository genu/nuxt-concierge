// Stub — Task 9 replaces this file with the bounded drain sequence.
import type { Supervisor } from './supervisor'

export interface NitroAppLike {
  hooks: { hookOnce: (name: string, fn: () => Promise<void> | void) => void }
}

export const installShutdown = (_nitroApp: NitroAppLike, _supervisor: Supervisor): void => {}
