import type { Overview } from './types'

const json = async <T>(url: string): Promise<T> => {
  const res = await fetch(url)
  if (!res.ok) {
    // Every error route on the server (503 "driver unreachable"/"no
    // introspection", 404 "unknown queue"/"no such job", 400 "unknown
    // state") answers with a JSON `{ error }` body naming the actual cause —
    // e.g. "the bullmq driver did not respond within 1500ms". Falling back to
    // `res.statusText` alone would throw that away and leave every one of
    // those callers with a generic "503 Service Unavailable", which is
    // exactly the kind of unexplained failure this fix exists to avoid.
    const body = await res.json().catch(() => undefined) as { error?: string } | undefined
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export interface JobSummaryView {
  id: string
  name: string
  queue: string
  state: string
  attemptsMade: number
  attempts?: number
  createdAt: number
  finishedAt?: number
  failedReason?: string
}

export interface JobDetailView extends JobSummaryView {
  payload: { ok: true, value: unknown } | { ok: false, error: string }
  stack?: string
  raw?: Record<string, unknown>
}

export interface ScheduleView {
  id: string
  jobName: string
  queue: string
  expression: string
  tz: string
  next?: number
  iterationCount?: number
}

export interface RegistryView {
  jobs: Array<{
    name: string
    queue: string
    file?: string
    hasSchema: boolean
    schemaVendor?: string
    attempts: { value: number, from: 'job' | 'defaults' }
    backoff: { value: { type: string, delay: number }, from: 'job' | 'defaults' }
  }>
  generatedTypes?: string
}

export const api = {
  overview: () => json<Overview>('/_concierge/api/overview'),
  jobs: (queue: string, state: string, offset = 0, limit = 25) =>
    json<{ items: JobSummaryView[], total: number }>(
      `/_concierge/api/queues/${encodeURIComponent(queue)}/jobs?state=${state}&offset=${offset}&limit=${limit}`,
    ),
  job: (queue: string, id: string) =>
    json<JobDetailView>(
      `/_concierge/api/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}`,
    ),
  retry: async (queue: string, id: string) => {
    const res = await fetch(
      `/_concierge/api/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}/retry`,
      { method: 'POST' },
    )
    if (res.status === 204) return
    // The server's 409 message names the actual cause (e.g. eviction from the
    // memory driver's bounded history). Surfacing it beats a generic failure.
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `retry failed with ${res.status}`)
  },
  registry: () => json<RegistryView>('/_concierge/api/registry'),
  // The list degrades per queue rather than failing whole: `unreadableQueues`
  // names the queues whose driver read timed out, so the panel can tell "no
  // schedules declared" apart from "some queues could not be read" instead
  // of quietly rendering a short list as if it were complete.
  schedules: () => json<{ items: ScheduleView[], unreadableQueues: string[] }>('/_concierge/api/schedules'),
  runSchedule: async (name: string) => {
    const res = await fetch(
      `/_concierge/api/schedules/${encodeURIComponent(name)}/run`,
      { method: 'POST' },
    )
    if (res.ok) return res.json() as Promise<{ id: string, deduplicated: boolean }>
    // Matches `retry`'s precedent: the server's 404/409/503 all name their
    // own cause (no such scheduled job, the driver's own enqueue error, no
    // supervisor), and falling back to a generic status text would throw
    // that reason away.
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `run failed with ${res.status}`)
  },
}
