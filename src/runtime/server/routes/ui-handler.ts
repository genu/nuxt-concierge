import { defineEventHandler, setResponseStatus } from 'h3'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { H3Adapter } from '@bull-board/h3'
import { Queue } from 'bullmq'
import { resolvePath } from 'mlly'
import { dirname } from 'pathe'
import { useRuntimeConfig } from '#imports'
import { getSupervisor } from '#concierge/supervisor'

// Built once, not per request. The previous implementation re-instantiated the
// board and its adapters on every request against a module-scoped adapter.
let handler: ((event: never) => unknown) | undefined

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

  if (!handler) {
    const uiPath = dirname(await resolvePath('@bull-board/ui/package.json', { url: import.meta.url }))
    const serverAdapter = new H3Adapter()
    serverAdapter.setBasePath('/_concierge')

    createBullBoard({
      queues: Object.keys(config.worker.queues).map(
        name => new BullMQAdapter(new Queue(name, { connection: { ...config.connection } as never })),
      ),
      serverAdapter,
      options: { uiBasePath: uiPath, uiConfig: { boardTitle: 'Concierge' } },
    })

    handler = serverAdapter.registerHandlers().handler
  }

  return handler(event as never)
})
