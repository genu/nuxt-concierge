import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { useQueue } from '../../utils/useQueue'

/**
 * Dev-only, and a WRITE — which needs no new security argument, because the
 * retry route already established that the dev dashboard performs writes and
 * spec 4's registration-time gating covers both unchanged.
 *
 * Enqueues through `useQueue` rather than the driver directly, so the job goes
 * through the same validation, retry-option resolution and deduplication as a
 * real enqueue. A run-now that bypassed those would be testing a code path no
 * production tick uses.
 */
export default defineEventHandler(async (event) => {
  const supervisor = getSupervisor()
  if (!supervisor) {
    setResponseStatus(event, 503)
    return { error: 'the supervisor has not started yet' }
  }

  const name = getRouterParam(event, 'name')
  const job = supervisor.config.jobs.find(j => j.name === name)
  if (!job?.cron) {
    setResponseStatus(event, 404)
    return { error: `no scheduled job named "${name}"` }
  }

  try {
    const result = await useQueue().enqueue(job.name, job.cron.payload)
    setResponseStatus(event, 202)
    return result
  }
  catch (error) {
    // 409 with the driver's own message, matching the retry route: a dedup
    // suppression or a validation failure both name their own cause, and
    // swallowing that into a generic 500 renders as "run failed" with no reason.
    setResponseStatus(event, 409)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
