import { defineEventHandler, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { DRIVER_READ_TIMEOUT_MS, readSchedules } from '../../introspect'
import type { DriverScheduling, ScheduleSummary } from '../../drivers/types'

export interface SchedulesListResponse {
  items: ScheduleSummary[]
  /**
   * Empty in the healthy case. The panel renders a warning only when this is
   * non-empty, so "no schedules" and "could not read" stay distinguishable —
   * the same distinction `introspectable`/`schedulable` exist to preserve.
   */
  unreadableQueues: string[]
}

/**
 * Degrades PER QUEUE rather than failing the whole request, mirroring
 * `buildOverview`'s handling of the identical multi-queue aggregation
 * problem. One unhealthy queue must not blank a panel that could still show
 * every other queue's schedules — and a partial answer that says which
 * queues are missing is honest, where a silently short list would not be.
 *
 * Exported (rather than left inline in the handler below) so this — the only
 * logic in this route worth a test — is testable directly, the same move
 * `registry.ts`'s `buildRegistry` already makes.
 */
export const readAllSchedules = async (
  schedule: DriverScheduling,
  driverName: string,
  queues: string[],
  /** Overridable so tests can exercise the timeout path without a real wait. */
  timeoutMs: number = DRIVER_READ_TIMEOUT_MS,
): Promise<SchedulesListResponse> => {
  const results = await Promise.all(queues.map(async (queue) => {
    try {
      return { queue, items: await readSchedules(schedule, driverName, queue, timeoutMs) }
    }
    catch {
      return { queue, items: undefined }
    }
  }))

  return {
    items: results.flatMap(r => r.items ?? []),
    unreadableQueues: results.filter(r => !r.items).map(r => r.queue),
  }
}

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
  // Two different causes, two different messages, matching `schedules-run.ts`.
  // Collapsing them into one `!supervisor?.driver.schedule` check told a
  // developer whose supervisor had not booted yet that their DRIVER lacked
  // scheduling — sending them to the wrong half of their config.
  if (!supervisor) {
    setResponseStatus(event, 503)
    return { error: 'the supervisor has not started yet' }
  }
  if (!supervisor.driver.schedule) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support scheduling' }
  }

  return readAllSchedules(
    supervisor.driver.schedule,
    supervisor.driver.name,
    Object.keys(supervisor.config.worker.queues),
  )
})
