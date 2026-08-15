/**
 * Mirrors OverviewResponse in src/runtime/server/introspect.ts. Hand-mirrored
 * rather than imported: the SPA is a separate Vite build with no path into the
 * module's source tree, and wiring one up to share four interfaces would couple
 * the client's typecheck to the server's build output.
 */
export interface Overview {
  state: 'starting' | 'running' | 'draining' | 'stopped' | 'absent'
  role: string
  driver: string
  driverHealthy: boolean
  /** Undefined when there is no supervisor, so every read must be optional. */
  capabilities?: { persistent: boolean, crossProcess: boolean, history: 'durable' | 'bounded' | 'none' }
  introspectable: boolean
  /** Whether the driver can schedule at all. Computed server-side. */
  schedulable: boolean
  version: string
  /** `counts` is absent when the driver has no introspection — not zeroed. */
  queues: Array<{ name: string, concurrency: number, counts?: Record<string, number> }>
  workers: Array<{
    id: string
    pid: number
    role: string
    state: string
    /** Computed server-side. The SPA never derives staleness itself. */
    stale: boolean
    active: unknown[]
    /** Per-queue concurrency this worker was started with. Raw, not derived. */
    concurrency: Record<string, number>
  }>
}
