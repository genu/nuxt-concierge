import type { JobDefinition, JobHandler } from '../types'

export interface DefineJobOptions {
  /** Defaults to the filename, resolved at build time. */
  name?: string
  /** Must exist in concierge.worker.queues or the build fails. */
  queue?: string
  handler: JobHandler
}

/**
 * Phase 1 shape: untyped payload, no codegen. Spec 3 adds the generated
 * name -> payload map and makes enqueue generic over it.
 */
export const defineJob = (opts: DefineJobOptions): JobDefinition => {
  if (typeof opts?.handler !== 'function') {
    throw new Error('[nuxt-concierge] defineJob requires a handler function')
  }

  return {
    name: opts.name ?? '',
    queue: opts.queue ?? 'default',
    handler: opts.handler,
  }
}
