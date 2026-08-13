import { getDriver } from '../supervisor'

export interface EnqueueJobOptions {
  delay?: number
}

/**
 * Enqueue from anywhere in server/. Phase 1 takes an untyped payload and a
 * string name; spec 3 generates a name -> payload map and makes this generic.
 *
 * The queue always comes from the route map (built from each job's own
 * `defineJob` declaration), never from a caller-supplied override: an
 * override would let a typo'd queue name bypass the "no such job" check
 * entirely and go straight to the driver.
 */
export const useQueue = () => ({
  enqueue: async (name: string, payload: unknown, opts: EnqueueJobOptions = {}) => {
    const { driver, routes } = getDriver()
    const queue = routes.get(name)

    if (!queue) {
      throw new Error(
        `[nuxt-concierge] no job named "${name}" is registered. `
        + `Create server/jobs/${name}.ts.`,
      )
    }

    return driver.enqueue(queue, { name, payload, delay: opts.delay })
  },
})
