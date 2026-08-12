import { consola } from 'consola'
import type { Supervisor } from './supervisor'
import type { ActiveJob } from './types'

const logger = consola.create({}).withTag('nuxt-concierge')

export interface DrainOptions {
  timeout: number
}

export interface DrainOutcome {
  forced: boolean
  abandoned: ActiveJob[]
  deregistered: boolean
}

const withDeadline = async <T>(promise: Promise<T>, ms: number): Promise<{ timedOut: boolean }> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms))
  })

  try {
    const result = await Promise.race([promise.then(() => 'done' as const), timeout])
    return { timedOut: result === 'timeout' }
  }
  finally {
    clearTimeout(timer!)
  }
}

/**
 * The whole sequence shares ONE deadline computed at entry — not just the
 * drain step. pause(), consumer close, driver close and deregistration can
 * each block or reject, and an unbounded shutdown is SIGKILLed by the
 * platform, which loses the clean path entirely. A slow pause() must not be
 * able to consume the whole budget and leave nothing for deregistration.
 */
export const runDrain = async (
  supervisor: Supervisor,
  { timeout }: DrainOptions,
): Promise<DrainOutcome> => {
  const deadline = Date.now() + timeout
  const remaining = () => deadline - Date.now()

  supervisor.setState('draining')

  const consumers = [...supervisor.consumers.values()]
  let forced = false
  let abandoned: ActiveJob[] = []

  try {
    // 1. Stop fetching. Must not await active jobs (see Consumer.pause).
    await withDeadline(
      Promise.allSettled(consumers.map(c => c.pause())).then(() => undefined),
      remaining(),
    )

    // 2. Wait for in-flight to reach zero, bounded by what is left.
    const drained = await withDeadline(
      Promise.all(consumers.map(c => c.drain())).then(() => undefined),
      remaining(),
    )

    if (drained.timedOut) {
      forced = true
      // 3. Snapshot BEFORE forcing: close(true) can clear local active
      // tracking, and job IDs are what make abandoned jobs findable in the
      // dashboard afterwards.
      abandoned = consumers.flatMap(c => c.active())
      await Promise.allSettled(consumers.map(c => c.close(true)))

      logger.warn(
        `Shutdown exceeded ${timeout}ms; force-closed with ${abandoned.length} job(s) in flight. `
        + `These are eligible for redelivery: ${abandoned.map(j => j.jobId).join(', ') || 'none'}`,
      )
    }
    else {
      // 4. Clean path.
      await Promise.allSettled(consumers.map(c => c.close(false)))
      logger.info('Workers drained cleanly')
    }
  }
  catch (error) {
    forced = true
    logger.error('Drain failed', error)
  }
  finally {
    // 5. Always deregister and close the driver, on every path — clean,
    // forced, and when an earlier step threw.
    await withDeadline(
      supervisor.driver.deregister(supervisor.id).catch(() => {}),
      Math.max(remaining(), 1000),
    )
    await withDeadline(
      supervisor.driver.close(forced).catch(() => {}),
      Math.max(remaining(), 1000),
    )
    supervisor.setState('stopped')
  }

  return { forced, abandoned, deregistered: true }
}

export interface NitroAppLike {
  hooks: { hookOnce: (name: string, fn: () => Promise<void> | void) => void }
}

/**
 * `ready` is a Promise<Supervisor>, not a Supervisor: nitro calls server
 * plugins without awaiting them, so the generated plugin registers this hook
 * synchronously — before it awaits supervisor creation (see the ordering
 * comment in templates.ts) — and hands us the in-flight promise instead of
 * the resolved value.
 */
export const installShutdown = (nitroApp: NitroAppLike, ready: Promise<Supervisor>): void => {
  let signalled = false
  let supervisor: Supervisor | undefined

  // A signal can arrive before boot finishes. Track the resolved supervisor
  // so the instant it exists we can flip its state if a signal already came
  // in, without making the close hook itself do anything but await + drain.
  ready.then(
    (s) => {
      supervisor = s
      if (signalled) s.setState('draining')
    },
    () => {
      // Boot failed; there is nothing to flip. The close hook below
      // tolerates the same rejection and returns quietly.
    },
  )

  const onSignal = () => {
    if (signalled) {
      // Nitro's own handler uses a once-factory and ignores repeat signals,
      // so the double-signal escape hatch has to be ours.
      logger.warn('Second signal received; exiting immediately')
      process.exit(1)
      return
    }
    signalled = true
    // Synchronous and immediate: flips readiness to 503 while the HTTP
    // listener is still up. The actual drain happens in the close hook.
    supervisor?.setState('draining')
  }

  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  // Nitro awaits this. It fires AFTER Nitro has drained HTTP connections,
  // which is why role: worker refuses application routes — a worker with no
  // long-lived connections reaches this almost immediately.
  nitroApp.hooks.hookOnce('close', async () => {
    let resolved: Supervisor
    try {
      resolved = await ready
    }
    catch {
      // Boot never completed; there is nothing to drain.
      return
    }

    await runDrain(resolved, { timeout: resolved.config.worker.shutdownTimeout })
  })
}

/**
 * Purely a type-inference helper — the identity function at runtime, never
 * called anywhere except to wrap the generated plugin's export.
 *
 * The generated `0.concierge-nuxt-plugin.ts` is parsed as plain JavaScript
 * by an earlier, non-TypeScript-aware stage of nitro's own rollup pipeline
 * (a raw acorn parse of the virtual plugins module, which runs before any
 * esbuild/TS transform touches this file) — confirmed empirically: both a
 * `(nitroApp: NitroAppLike) => ...` parameter annotation and an
 * `import type { NitroAppLike }` statement broke that parse with
 * "Expected ',', got ':'"/"got '{'". The generated file therefore cannot
 * contain ANY TypeScript-only syntax. Wrapping its plugin function in a
 * call to this helper lets the inner arrow function's `nitroApp` parameter
 * be typed via ordinary contextual typing instead — TypeScript infers the
 * parameter type from `defineConciergePlugin`'s own signature, so the
 * generated file needs zero additional syntax at the call site and stays
 * parseable as plain JS.
 */
export const defineConciergePlugin = (
  fn: (nitroApp: NitroAppLike) => unknown,
): (nitroApp: NitroAppLike) => unknown => fn
