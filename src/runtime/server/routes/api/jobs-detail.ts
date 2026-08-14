import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { toDetailResponse } from '../../introspect'

export default defineEventHandler(async (event) => {
  const supervisor = getSupervisor()
  // Checked on `supervisor` itself, not `supervisor?.driver.introspect` alone,
  // for the same reason as the list handler: narrowing `introspect` does not
  // narrow `supervisor`, and the queue validation below reads `supervisor.config`.
  if (!supervisor?.driver.introspect) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support introspection' }
  }
  const introspect = supervisor.driver.introspect

  const queue = getRouterParam(event, 'queue')
  // Validated against the declared queue set BEFORE it reaches the driver:
  // the memory driver's queueOf/historyOf create a Map entry on ANY read, so
  // forwarding an arbitrary queue-name string here is an unbounded-growth
  // vector. 404, exactly like the list handler, rather than letting the
  // driver silently materialise a queue that was never configured.
  if (!queue || !(queue in supervisor.config.worker.queues)) {
    setResponseStatus(event, 404)
    return { error: `unknown queue "${queue}"` }
  }

  const id = getRouterParam(event, 'id')!
  const detail = await introspect.get(queue, id)

  if (!detail) {
    setResponseStatus(event, 404)
    return { error: `no job "${id}" on queue "${queue}"` }
  }

  return toDetailResponse(detail)
})
