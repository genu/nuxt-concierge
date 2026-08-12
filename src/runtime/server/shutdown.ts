import { consola } from 'consola'
import type { Supervisor } from './supervisor'
import type { Consumer } from './drivers'
import type { ActiveJob } from './types'

const logger = consola.create({}).withTag('nuxt-concierge')

export interface DrainOptions {
  timeout: number
}

export interface DrainOutcome {
  forced: boolean
  abandoned: ActiveJob[]
  /** Reflects whether deregister() actually resolved in time, not a hardcoded assumption. */
  deregistered: boolean
}

/**
 * Races `promise` against a timer. Only reports which one won — used for
 * steps whose sole interesting outcome is "did it finish in time", not what
 * it produced (pause, close, deregister).
 */
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
 * Races `promise` against a timer, surfacing the settled value when the
 * promise wins. Used for the drain step, where we need to know not just
 * whether it finished in time but whether any consumer's drain() rejected —
 * `withDeadline` above discards the value, so it can't answer that.
 */
const raceDeadline = async <T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: true } | { timedOut: false, value: T }> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms))
  })

  try {
    return await Promise.race([
      promise.then(value => ({ timedOut: false as const, value })),
      timeout,
    ])
  }
  finally {
    clearTimeout(timer!)
  }
}

/**
 * Snapshot, force-close, log — the one step shared by both places a drain can
 * end up needing to force-close: a drain() that timed out/rejected, and a
 * clean close(false) that itself blows the budget. Factored out so those two
 * paths cannot drift apart (e.g. one snapshotting before forcing and the
 * other forgetting to).
 */
const forceCloseAndLog = async (
  consumers: Consumer[],
  remaining: () => number,
  reason: string,
): Promise<ActiveJob[]> => {
  // Snapshot BEFORE forcing: close(true) can clear local active tracking,
  // and job IDs are what make abandoned jobs findable in the dashboard
  // afterwards.
  const abandoned = consumers.flatMap(c => c.active())

  // Force-close is itself bounded by the shared deadline. Both real drivers
  // make this call blocking (bullmq's close is worker.close(force) +
  // redis.quit(); memory's close polls), so an unresponsive Redis must not be
  // able to hang here and starve the finally block below.
  await withDeadline(
    Promise.allSettled(consumers.map(c => c.close(true))).then(() => undefined),
    remaining(),
  )

  logger.warn(
    `${reason} force-closed with ${abandoned.length} job(s) in flight. `
    + `These are eligible for redelivery: ${abandoned.map(j => j.jobId).join(', ') || 'none'}`,
  )

  return abandoned
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
  // Stop heartbeats before deregistering: a tick landing between
  // deregister() resolving and driver.close() would otherwise re-write the
  // worker record with a fresh TTL, leaving a phantom worker in the
  // registry after the process is already gone.
  supervisor.stopHeartbeat()

  const consumers = [...supervisor.consumers.values()]
  let forced = false
  let abandoned: ActiveJob[] = []
  let deregistered = false

  try {
    // 1. Stop fetching. Must not await active jobs (see Consumer.pause).
    await withDeadline(
      Promise.allSettled(consumers.map(c => c.pause())).then(() => undefined),
      remaining(),
    )

    // 2. Wait for in-flight to reach zero, bounded by what is left. A
    // rejecting drain() is treated exactly like a timed-out one: something
    // went wrong mid-drain, so the honest response is to force-close and
    // report the jobs still in flight, not to lose their IDs silently
    // (Promise.all would have short-circuited and skipped close() entirely).
    const drainRace = await raceDeadline(
      Promise.allSettled(consumers.map(c => c.drain())),
      remaining(),
    )
    const drainFailed = drainRace.timedOut || drainRace.value.some(r => r.status === 'rejected')

    if (drainFailed) {
      // 3/4. Snapshot, force-close, log — see forceCloseAndLog.
      forced = true
      abandoned = await forceCloseAndLog(consumers, remaining, `Shutdown exceeded ${timeout}ms;`)
    }
    else {
      // 5. Clean path — also bounded, for the same reason as above. This can
      // itself blow the budget: drain() only polls each driver's own
      // in-processor `active` map, so a job fetched but not yet dispatched
      // when worker.pause(true) lands leaves that map transiently empty —
      // drain() returns, drainFailed is false, and close(false) then blocks
      // on that very job. Treat that exactly like a timed-out/rejected
      // drain: force-close and report the abandoned IDs, rather than logging
      // a "drained cleanly" line that isn't true.
      const cleanClose = await withDeadline(
        Promise.allSettled(consumers.map(c => c.close(false))).then(() => undefined),
        remaining(),
      )

      if (cleanClose.timedOut) {
        forced = true
        abandoned = await forceCloseAndLog(consumers, remaining, `close(false) exceeded ${timeout}ms;`)
      }
      else {
        logger.info('Workers drained cleanly')
      }
    }
  }
  catch (error) {
    forced = true
    logger.error('Drain failed', error)
  }
  finally {
    // 6. Always deregister and close the driver, on every path — clean,
    // forced, and when an earlier step threw. `deregistered` reflects
    // whether this actually completed, so the field never lies.
    const deregisterRace = await withDeadline(
      supervisor.driver.deregister(supervisor.id)
        .then(() => { deregistered = true })
        .catch((error: unknown) => logger.error('Failed to deregister worker', error)),
      Math.max(remaining(), 1000),
    )
    if (deregisterRace.timedOut) {
      logger.error('Deregistration did not complete within the shutdown grace period')
    }

    await withDeadline(
      supervisor.driver.close(forced).catch((error: unknown) => logger.error('Failed to close driver', error)),
      Math.max(remaining(), 1000),
    )

    supervisor.setState('stopped')
  }

  return { forced, abandoned, deregistered }
}

export interface NitroAppLike {
  hooks: { hookOnce: (name: string, fn: () => Promise<void> | void) => void }
}

/**
 * Mirrors `moduleDefaults.worker.shutdownTimeout` (src/options.ts). Used only
 * as an upper bound while we wait for `ready` to resolve, before the actual
 * configured value is even known. Without this cap, a slow driver connect
 * could consume time silently before the drain's own deadline is ever
 * computed, so the sum of (boot wait + drain) would be unbounded even though
 * `shutdownTimeout` itself is configured sensibly.
 */
const DEFAULT_BOOT_WAIT_MS = 20_000

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

  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      // Nitro's own handler uses a once-factory and ignores repeat signals,
      // so the double-signal escape hatch has to be ours. Conventional exit
      // codes: 128 + signal number (SIGINT=2, SIGTERM=15).
      logger.warn(`Second ${signal} received; exiting immediately`)
      process.exit(signal === 'SIGINT' ? 130 : 143)
      return
    }
    signalled = true
    // Synchronous and immediate: flips readiness to 503 while the HTTP
    // listener is still up. The actual drain happens in the close hook.
    supervisor?.setState('draining')
  }

  const onSigterm = () => onSignal('SIGTERM')
  const onSigint = () => onSignal('SIGINT')
  process.on('SIGTERM', onSigterm)
  process.on('SIGINT', onSigint)

  // Nitro awaits this. It fires AFTER Nitro has drained HTTP connections,
  // which is why role: worker refuses application routes — a worker with no
  // long-lived connections reaches this almost immediately.
  nitroApp.hooks.hookOnce('close', async () => {
    try {
      // One deadline for the whole close hook, computed before the
      // configured shutdownTimeout is even known: a slow driver connect
      // must not be able to consume time before the drain's own deadline
      // exists, or (boot wait + drain) becomes unbounded even with a
      // perfectly sane shutdownTimeout. `ready.catch` tolerates rejection so
      // the race itself never rejects; the real rejection is handled below.
      const hookStart = Date.now()
      const bootWait = await withDeadline(ready.catch(() => undefined), DEFAULT_BOOT_WAIT_MS)

      if (bootWait.timedOut) {
        logger.error('Supervisor did not become ready within the shutdown boot budget; nothing to drain')
        return
      }

      let resolved: Supervisor
      try {
        resolved = await ready
      }
      catch {
        // Boot never completed; there is nothing to drain.
        return
      }

      const elapsed = Date.now() - hookStart
      const drainTimeout = Math.max(0, resolved.config.worker.shutdownTimeout - elapsed)
      await runDrain(resolved, { timeout: drainTimeout })
    }
    catch (error) {
      logger.error('Unexpected error while draining', error)
    }
    finally {
      // Removed once the close hook completes rather than left attached
      // forever: in dev, Nitro reloads would otherwise accumulate listeners
      // across restarts, producing a MaxListeners warning and stale
      // closures over long-dead supervisors.
      process.off('SIGTERM', onSigterm)
      process.off('SIGINT', onSigint)
    }
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
