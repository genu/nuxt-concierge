import { defineEventHandler, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { DriverReadTimeoutError, readSchedules } from '../../introspect'

/**
 * Registered only under nuxt.options.dev (see src/module.ts), so this file is
 * never part of a production bundle and needs no auth check of its own.
 *
 * Unpaginated, deliberately: schedules are declared in source, so their count
 * is bounded by the size of the codebase rather than by traffic. That is the
 * opposite of the jobs list, whose MAX_LIMIT exists for a real reason.
 */
export default defineEventHandler(async (event) => {
  const supervisor = getSupervisor()
  if (!supervisor?.driver.schedule) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support scheduling' }
  }
  const schedule = supervisor.driver.schedule

  try {
    const queues = Object.keys(supervisor.config.worker.queues)
    const perQueue = await Promise.all(
      queues.map(queue => readSchedules(schedule, supervisor.driver.name, queue)),
    )
    return { items: perQueue.flat() }
  }
  catch (error) {
    if (error instanceof DriverReadTimeoutError) {
      setResponseStatus(event, 503)
      return { error: error.message }
    }
    setResponseStatus(event, 500)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
