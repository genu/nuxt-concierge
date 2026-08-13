import { describe, it, expect, vi, afterEach } from 'vitest'
import { installShutdown } from '../../src/runtime/server/shutdown'

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

const fakeConsumer = (opts: { drainMs?: number } = {}) => ({
  pause: vi.fn(async () => {}),
  drain: vi.fn(async () => { await tick(opts.drainMs ?? 0) }),
  close: vi.fn(async () => {}),
  activeCount: () => 0,
  active: () => [],
})

const fakeSupervisor = (shutdownTimeout: number, consumers: ReturnType<typeof fakeConsumer>[] = []) => ({
  id: 'w1',
  consumers: new Map(consumers.map((c, i) => [`q${i}`, c])),
  driver: { deregister: vi.fn(async () => {}), close: vi.fn(async () => {}) },
  config: { worker: { shutdownTimeout } },
  setState: vi.fn(),
  getState: vi.fn(() => 'draining' as const),
  stopHeartbeat: vi.fn(async () => {}),
})

type FakeSupervisor = ReturnType<typeof fakeSupervisor>

const fakeNitroApp = () => {
  const hooks = new Map<string, () => Promise<void> | void>()
  return {
    app: { hooks: { hookOnce: (name: string, fn: () => Promise<void> | void) => hooks.set(name, fn) } },
    closeHook: () => hooks.get('close'),
  }
}

// installShutdown attaches real SIGTERM/SIGINT listeners; clean up after
// every test so a leaked listener from one test cannot react to a signal
// emitted by a later one. Snapshot-and-restore rather than
// removeAllListeners: the latter also strips vitest's own SIGTERM/SIGINT
// handlers (needed for its own teardown/watch-mode interrupt handling), so
// only the listeners this test file itself adds are removed.
const preexistingListeners = {
  SIGTERM: new Set(process.listeners('SIGTERM')),
  SIGINT: new Set(process.listeners('SIGINT')),
}

afterEach(() => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!preexistingListeners[signal].has(listener)) {
        process.removeListener(signal, listener)
      }
    }
  }
})

describe('installShutdown', () => {
  it('flips state to draining synchronously on the first signal, without awaiting anything', async () => {
    const supervisor = fakeSupervisor(1000)
    const ready = Promise.resolve(supervisor as never)
    const { app } = fakeNitroApp()

    installShutdown(app as never, ready)
    // Let the internal `ready.then` continuation populate the closed-over
    // supervisor reference before signalling.
    await ready

    process.emit('SIGTERM')

    // No await between emit() and this assertion: onSignal is a plain
    // synchronous function, so by the time emit() returns, setState has
    // already been called.
    expect(supervisor.setState).toHaveBeenCalledWith('draining')
  })

  it('flips state once the supervisor resolves if a signal arrived mid-boot', async () => {
    const supervisor = fakeSupervisor(1000)
    let resolveReady!: (s: FakeSupervisor) => void
    const ready = new Promise<FakeSupervisor>((resolve) => { resolveReady = resolve })
    const { app } = fakeNitroApp()

    installShutdown(app as never, ready as never)

    process.emit('SIGTERM')
    expect(supervisor.setState).not.toHaveBeenCalled()

    resolveReady(supervisor)
    await ready

    expect(supervisor.setState).toHaveBeenCalledWith('draining')
  })

  it('exits immediately with code 143 on a second SIGTERM', async () => {
    const supervisor = fakeSupervisor(1000)
    const ready = Promise.resolve(supervisor as never)
    const { app } = fakeNitroApp()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    installShutdown(app as never, ready)
    await ready

    process.emit('SIGTERM')
    process.emit('SIGTERM')

    expect(exit).toHaveBeenCalledWith(143)
    exit.mockRestore()
  })

  it('exits immediately with code 130 on a second SIGINT', async () => {
    const supervisor = fakeSupervisor(1000)
    const ready = Promise.resolve(supervisor as never)
    const { app } = fakeNitroApp()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    installShutdown(app as never, ready)
    await ready

    process.emit('SIGINT')
    process.emit('SIGINT')

    expect(exit).toHaveBeenCalledWith(130)
    exit.mockRestore()
  })

  it('does not exit on a single signal', async () => {
    const supervisor = fakeSupervisor(1000)
    const ready = Promise.resolve(supervisor as never)
    const { app } = fakeNitroApp()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    installShutdown(app as never, ready)
    await ready

    process.emit('SIGTERM')

    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })

  it('the close hook tolerates a rejected ready and returns quietly', async () => {
    const ready = Promise.reject(new Error('boot failed'))
    ready.catch(() => {})
    const { app, closeHook } = fakeNitroApp()

    installShutdown(app as never, ready)

    await expect(closeHook()?.()).resolves.toBeUndefined()
  })

  it('removes its signal listeners once the close hook completes', async () => {
    const supervisor = fakeSupervisor(1000)
    const ready = Promise.resolve(supervisor as never)
    const { app, closeHook } = fakeNitroApp()

    const before = process.listenerCount('SIGTERM')
    installShutdown(app as never, ready)
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)

    await closeHook()?.()

    expect(process.listenerCount('SIGTERM')).toBe(before)
  })

  it('subtracts time already spent waiting for ready from the drain budget', async () => {
    // shutdownTimeout is 500ms; ready resolves after ~300ms (a slow driver
    // connect). Only ~200ms should be left for a consumer whose drain() takes
    // 400ms, so it must be force-closed almost immediately once that ~200ms
    // remainder elapses, rather than waiting out the full 400ms drain.
    //
    // `c.close` being called with `true` is NOT a usable signal here: the
    // clean path forces (close(true)) even when nothing timed out (see the
    // comment at the call site in shutdown.ts), so that assertion passes
    // identically whether or not this budget subtraction happens at all.
    // Total close-hook DURATION is what actually distinguishes the two:
    // under the bug this guards against — using the full configured timeout
    // for runDrain regardless of time already spent awaiting `ready` — 500ms
    // would comfortably cover the 300ms wait plus the full 400ms drain
    // (~700ms total) and the hook would take that long instead of the
    // ~500ms a correctly-subtracted budget produces.
    const c = fakeConsumer({ drainMs: 400 })
    const supervisor = fakeSupervisor(500, [c])
    const ready = new Promise<FakeSupervisor>((resolve) => {
      setTimeout(() => resolve(supervisor), 300)
    })
    const { app, closeHook } = fakeNitroApp()

    installShutdown(app as never, ready as never)
    const started = Date.now()
    await closeHook()?.()
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(650)
    expect(c.close).toHaveBeenCalledWith(true)
  })
})
