import { getDriver } from '../supervisor'

export interface EnqueueJobOptions {
  delay?: number
  queue?: string
}

/**
 * Enqueue from anywhere in server/. Phase 1 takes an untyped payload and a
 * string name; spec 3 generates a name -> payload map and makes this generic.
 */
export const useQueue = () => ({
  enqueue: async (name: string, payload: unknown, opts: EnqueueJobOptions = {}) => {
    const { driver, routes } = getDriver()
    const queue = opts.queue ?? routes.get(name)

    if (!queue) {
      throw new Error(
        `[nuxt-concierge] no job named "${name}" is registered. `
        + `Create server/jobs/${name}.ts, or pass an explicit queue.`,
      )
    }

    return driver.enqueue(queue, { name, payload, delay: opts.delay })
  },
})
