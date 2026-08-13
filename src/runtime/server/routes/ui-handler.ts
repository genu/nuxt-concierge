import { defineEventHandler, setResponseStatus } from 'h3'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { H3Adapter } from '@bull-board/h3'
import { Queue } from 'bullmq'
import { resolvePath } from 'mlly'
import { dirname } from 'pathe'
import { useRuntimeConfig } from '#imports'
import { useNitroApp } from 'nitropack/runtime'
import { getSupervisor } from '#concierge/supervisor'

type ConciergeConfig = ReturnType<typeof useRuntimeConfig>['concierge']

interface BuiltHandler {
  handler: (event: never) => unknown
  /**
   * Kept, not discarded: each is a Redis connection separate from the
   * driver's own (a fresh `new Queue()` per dashboard queue), and nothing
   * else in the process closes them. Tracked so the shutdown hook below can
   * release them.
   */
  queues: Queue[]
}

/**
 * Cached as a PROMISE, not the resolved handler. Building involves an
 * `await` (`resolvePath`) before any `Queue`/`BullBoard` instance exists, so
 * two concurrent first requests both reading a plain `handler` variable
 * would both observe it unset and each build a full, independent BullBoard +
 * Queue set — one of those sets is then orphaned with its Redis connections
 * open for the process's remaining lifetime. Caching the in-flight promise
 * instead means the second request awaits the first request's build rather
 * than starting its own.
 */
let handlerPromise: Promise<BuiltHandler> | undefined

const buildHandler = async (config: ConciergeConfig): Promise<BuiltHandler> => {
  const uiPath = dirname(await resolvePath('@bull-board/ui/package.json', { url: import.meta.url }))
  const serverAdapter = new H3Adapter()
  serverAdapter.setBasePath('/_concierge')

  const queues = Object.keys(config.worker.queues).map(
    name => new Queue(name, { connection: { ...config.connection } as never }),
  )

  createBullBoard({
    queues: queues.map(q => new BullMQAdapter(q)),
    serverAdapter,
    options: { uiBasePath: uiPath, uiConfig: { boardTitle: 'Concierge' } },
  })

  return { handler: serverAdapter.registerHandlers().handler, queues }
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().concierge
  if (!config.managementUI) {
    setResponseStatus(event, 404)
    return ''
  }

  const supervisor = getSupervisor()
  if (supervisor?.driver.name !== 'bullmq') {
    setResponseStatus(event, 503)
    return { error: `The BullBoard dashboard requires the bullmq driver (current: ${supervisor?.driver.name ?? 'none'}).` }
  }

  // Assigned synchronously, before any `await` below — a second concurrent
  // request racing this one observes the SAME promise rather than starting
  // its own build.
  if (!handlerPromise) {
    const building = buildHandler(config)
    handlerPromise = building

    building.then(
      ({ queues }) => {
        // Registered once, right when the queues are actually created (a
        // request may never hit this route at all, in which case there is
        // nothing to close). Separate from the driver's own shutdown path
        // (shutdown.ts): these Queue instances are private to the
        // dashboard, not tracked by the driver, so nothing else releases
        // them.
        useNitroApp().hooks.hookOnce('close', async () => {
          await Promise.allSettled(queues.map(q => q.close()))
        })
      },
      () => {
        // Let a later request retry after a failed build, rather than
        // permanently caching a rejection. Guarded so a newer, already
        // in-flight retry (started by a request that raced this failure)
        // cannot be clobbered back to undefined by this stale callback.
        if (handlerPromise === building) handlerPromise = undefined
      },
    )
  }

  const { handler } = await handlerPromise
  return handler(event as never)
})
