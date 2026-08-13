export type Role = 'web' | 'worker' | 'both'
export type SupervisorState = 'starting' | 'running' | 'draining' | 'stopped'

export interface ActiveJob {
  jobId: string
  queue: string
  name: string
  startedAt: number
}

export interface WorkerRecord {
  id: string
  hostname: string
  pid: number
  /**
   * The supervisor's actual configured role, including `web`. A `web`
   * process's record used to be reported as `both`; Task 10's health
   * endpoint reads this field directly, so misreporting it would be a lie
   * a caller could act on.
   */
  role: Role
  queues: string[]
  concurrency: Record<string, number>
  version: string
  startedAt: number
  lastHeartbeat: number
  state: 'running' | 'draining'
  active: ActiveJob[]
}

/** What a handler receives. Untyped payload in phase 1; spec 3 makes it generic. */
export interface JobContext {
  id: string
  name: string
  queue: string
  attempt: number
  payload: unknown
}

export type JobHandler = (ctx: JobContext) => Promise<void> | void

export interface JobDefinition {
  name: string
  queue: string
  handler: JobHandler
}
