import { defineEventHandler, setResponseStatus } from 'h3'
import { getSupervisor } from '../supervisor'
import type { Supervisor } from '../supervisor'
import type { SupervisorState } from '../types'

/**
 * 200 only in `running` AND with a healthy driver connection. Readiness must
 * stay false until consumers are actually up — binding the listener is not
 * readiness — and it must flip back to false the moment the driver can no
 * longer reach its backing store (e.g. a dead Redis), otherwise a rolling
 * deploy promotes a worker that cannot process anything.
 */
export const healthStatus = (state: SupervisorState | undefined, driverHealthy = true): 200 | 503 =>
  state === 'running' && driverHealthy ? 200 : 503

export const healthPayload = (supervisor: Supervisor) => ({
  state: supervisor.getState(),
  role: supervisor.config.role,
  queues: Object.keys(supervisor.config.worker.queues),
  activeCount: [...supervisor.consumers.values()].reduce((n, c) => n + c.activeCount(), 0),
  version: supervisor.config.version,
  driverHealthy: supervisor.driver.isHealthy(),
})

export default defineEventHandler((event) => {
  const supervisor = getSupervisor()
  const status = healthStatus(supervisor?.getState(), supervisor?.driver.isHealthy())
  setResponseStatus(event, status)

  // Deliberately not shaped like healthPayload()'s `state` field: `stopped`
  // would be a lie here (the supervisor may never have existed at all, e.g.
  // mid-boot, not `stopped`), and SupervisorState gets no new member for a
  // case that only exists when there IS no supervisor to hold one.
  if (!supervisor) return { ready: false, error: 'the supervisor has not started yet' }
  return healthPayload(supervisor)
})
