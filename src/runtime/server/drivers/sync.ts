import { decodePayload, encodePayload } from '../envelope'
import type { JobHandler } from '../types'
import type { ConciergeDriver, Consumer } from './types'

const inertConsumer: Consumer = {
  pause: async () => {},
  drain: async () => {},
  close: async () => {},
  activeCount: () => 0,
  active: () => [],
}

/**
 * Executes handlers inline in the caller. Two deliberate consequences:
 * handler errors propagate to whoever called enqueue, and retries do not
 * apply. Both make tests fail loudly instead of swallowing failures.
 */
export const createSyncDriver = (): ConciergeDriver => {
  const handlers = new Map<string, JobHandler>()
  let counter = 0

  const key = (queue: string, name: string) => `${queue}::${name}`

  return {
    name: 'sync',
    capabilities: { persistent: false, crossProcess: false },

    init: async () => {},
    close: async () => {},

    registerHandler: (queue, name, handler) => {
      handlers.set(key(queue, name), handler)
    },

    enqueue: async (queue, job) => {
      const handler = handlers.get(key(queue, job.name))
      if (!handler) {
        throw new Error(`[nuxt-concierge] no handler registered for "${job.name}" on queue "${queue}"`)
      }

      // Round-trip through the envelope even though we never leave the process,
      // so sync and async drivers agree on what survives serialisation.
      const id = `sync-${++counter}`
      await handler({
        id,
        name: job.name,
        queue,
        attempt: 1,
        payload: decodePayload(encodePayload(job.payload)),
      })

      return { id }
    },

    consume: () => inertConsumer,
    depth: async () => 0,

    heartbeat: async () => {},
    deregister: async () => {},
    workers: async () => [],
  }
}
