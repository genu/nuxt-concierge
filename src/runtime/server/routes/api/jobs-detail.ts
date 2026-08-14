import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { DriverReadTimeoutError, readJobDetail, toDetailResponse } from '../../introspect'

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

  // Bounded for the same reason the list handler is: `introspect.get()` runs
  // over the same connection that can queue commands forever against a dead
  // Redis. `readJobDetail` throws on timeout (rather than the plain-
  // `undefined` `withTimeout` used by `buildOverview`) specifically so a
  // timeout can be told apart from `get()`'s own legitimate `undefined` —
  // "no such job" must still 404, not be swallowed into "the driver is
  // unreachable" or vice versa.
  let detail
  try {
    detail = await readJobDetail(introspect, supervisor.driver.name, queue, id)
  }
  catch (error) {
    if (error instanceof DriverReadTimeoutError) {
      setResponseStatus(event, 503)
      return { error: error.message }
    }
    throw error
  }

  if (!detail) {
    setResponseStatus(event, 404)
    return { error: `no job "${id}" on queue "${queue}"` }
  }

  return toDetailResponse(detail)
})
