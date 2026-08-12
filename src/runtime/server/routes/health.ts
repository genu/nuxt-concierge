import { defineEventHandler, setResponseStatus } from 'h3'
import { getSupervisor } from '../supervisor'
import type { Supervisor } from '../supervisor'
import type { SupervisorState } from '../types'

/**
 * 200 only in `running`. Readiness must stay false until consumers are
 * actually up — binding the listener is not readiness.
 */
export const healthStatus = (state: SupervisorState | undefined): 200 | 503 =>
  state === 'running' ? 200 : 503

export const healthPayload = (supervisor: Supervisor) => ({
  state: supervisor.getState(),
  role: supervisor.config.role,
  queues: Object.keys(supervisor.config.worker.queues),
  activeCount: [...supervisor.consumers.values()].reduce((n, c) => n + c.activeCount(), 0),
  version: supervisor.config.version,
})

export default defineEventHandler((event) => {
  const supervisor = getSupervisor()
  const status = healthStatus(supervisor?.getState())
  setResponseStatus(event, status)

  // Deliberately not shaped like healthPayload()'s `state` field: `stopped`
  // would be a lie here (the supervisor may never have existed at all, e.g.
  // mid-boot, not `stopped`), and SupervisorState gets no new member for a
  // case that only exists when there IS no supervisor to hold one.
  if (!supervisor) return { ready: false, error: 'the supervisor has not started yet' }
  return healthPayload(supervisor)
})
