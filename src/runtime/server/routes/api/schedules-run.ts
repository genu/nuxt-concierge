import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { useQueue } from '../../utils/useQueue'
import { DRIVER_READ_TIMEOUT_MS, DriverReadTimeoutError, driverTimeoutMessage, withTimeoutOrThrow } from '../../introspect'
import type { EnqueueResult } from '../../drivers/types'

/**
 * Bounded for the same reason as the jobs and schedules list/retry routes:
 * `enqueue` ends in a real driver write (`bullmq`'s is a Redis command), and a
 * dead connection queues it forever instead of rejecting — the third instance
 * of this bug (`jobs-retry.ts` bounds `retryJob`, `schedules-list.ts` bounds
 * `schedule.list`). Without this, the dashboard's "Run now" button hangs
 * silently while every other panel action errors cleanly.
 *
 * Takes the enqueue call as a thunk, and only `driverName`/`timeoutMs` besides
 * it, so it is testable with a hanging fake instead of a live supervisor
 * singleton.
 */
export const runScheduleNow = (
  enqueue: () => Promise<EnqueueResult>,
  driverName: string,
  timeoutMs: number = DRIVER_READ_TIMEOUT_MS,
): Promise<EnqueueResult> =>
  withTimeoutOrThrow(enqueue(), timeoutMs, driverTimeoutMessage(driverName, timeoutMs))

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

  // Captured before the closure below: TS narrows `job.cron` to defined only
  // within this scope, not inside a nested arrow function.
  const { name: jobName, cron } = job

  try {
    const result = await runScheduleNow(
      () => useQueue().enqueue(jobName, cron.payload),
      supervisor.driver.name,
    )
    setResponseStatus(event, 202)
    return result
  }
  catch (error) {
    // Checked FIRST, ahead of the generic catch, same ordering as
    // `jobs-retry.ts`: "the driver is unreachable" is a different failure than
    // "the enqueue was rejected", and needs its own status (503, not 409).
    if (error instanceof DriverReadTimeoutError) {
      setResponseStatus(event, 503)
      return { error: error.message }
    }
    // 409 with the driver's own message, matching the retry route: a
    // validation failure or a rejected write names its own cause, and
    // swallowing that into a generic 500 renders as "run failed" with no
    // reason.
    //
    // A dedup SUPPRESSION does not reach here. It is not an error — the
    // enqueue resolves with `{ deduplicated: true }` and the route answers 202
    // carrying that flag, which is the whole point of `EnqueueResult` having
    // one. Do not wire the panel to expect a 409 for it.
    setResponseStatus(event, 409)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
