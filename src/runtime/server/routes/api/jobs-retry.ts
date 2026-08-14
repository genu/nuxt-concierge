import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'

export default defineEventHandler(async (event) => {
  const supervisor = getSupervisor()
  // Same reasoning as the list and detail handlers: narrowing `introspect`
  // does not narrow `supervisor`, and the queue validation below reads
  // `supervisor.config`.
  if (!supervisor?.driver.introspect) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support introspection' }
  }
  const introspect = supervisor.driver.introspect

  const queue = getRouterParam(event, 'queue')
  // Validated against the declared queue set BEFORE it reaches the driver,
  // exactly like the list and detail handlers: the memory driver creates a
  // Map entry for ANY queue name it is asked to read, so an unvalidated
  // `queue` param here is an unbounded-growth vector.
  if (!queue || !(queue in supervisor.config.worker.queues)) {
    setResponseStatus(event, 404)
    return { error: `unknown queue "${queue}"` }
  }

  const id = getRouterParam(event, 'id')!

  try {
    await introspect.retry(queue, id)
    setResponseStatus(event, 204)
    return null
  }
  catch (error) {
    // 409, with the driver's own message. The memory driver's message names
    // eviction as a likely cause, which is exactly what a developer needs to
    // read; swallowing it into a generic 500 would render as "retry failed"
    // with no reason.
    setResponseStatus(event, 409)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
