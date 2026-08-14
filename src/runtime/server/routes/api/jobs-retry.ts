import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { DriverReadTimeoutError, retryJob } from '../../introspect'

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
    // Bounded for the same reason as the list and detail handlers: bullmq's
    // `retry()` does a redis read (`getJob`) and a redis write (`job.retry()`),
    // either of which can queue forever against a dead connection. Checked
    // FIRST, ahead of the generic catch below, because a timeout is a
    // different kind of failure than the ones that catch already handles —
    // "the driver is unreachable" is not "conflict" (409), it's "unavailable"
    // (503), the same status the list/detail handlers use for the identical
    // condition.
    await retryJob(introspect, supervisor.driver.name, queue, id)
    setResponseStatus(event, 204)
    return null
  }
  catch (error) {
    if (error instanceof DriverReadTimeoutError) {
      setResponseStatus(event, 503)
      return { error: error.message }
    }
    // 409, with the driver's own message. The memory driver's message names
    // eviction as a likely cause, which is exactly what a developer needs to
    // read; swallowing it into a generic 500 would render as "retry failed"
    // with no reason.
    setResponseStatus(event, 409)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
