import { describe, it, expect, vi } from 'vitest'
import { runDrain } from '../../src/runtime/server/shutdown'
import type { ActiveJob } from '../../src/runtime/server/types'

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

const fakeConsumer = (opts: {
  drainMs?: number
  pauseMs?: number
  active?: ActiveJob[]
  clearActiveOnForce?: boolean
} = {}) => {
  let active = opts.active ?? []
  return {
    pause: vi.fn(async () => { if (opts.pauseMs) await tick(opts.pauseMs) }),
    drain: vi.fn(async () => { await tick(opts.drainMs ?? 0) }),
    close: vi.fn(async (force: boolean) => { if (force && opts.clearActiveOnForce) active = [] }),
    activeCount: () => active.length,
    active: () => active,
  }
}

const fakeSupervisor = (consumers: ReturnType<typeof fakeConsumer>[]) => ({
  id: 'w1',
  consumers: new Map(consumers.map((c, i) => [`q${i}`, c])),
  driver: { deregister: vi.fn(async () => {}), close: vi.fn(async () => {}) },
  setState: vi.fn(),
  getState: vi.fn(() => 'draining' as const),
  stopHeartbeat: vi.fn(),
})

describe('runDrain', () => {
  it('pauses every consumer before draining', async () => {
    const c = fakeConsumer()
    const s = fakeSupervisor([c])

    await runDrain(s as never, { timeout: 1000 })

    expect(c.pause).toHaveBeenCalled()
    expect(c.pause.mock.invocationCallOrder[0]!)
      .toBeLessThan(c.drain.mock.invocationCallOrder[0]!)
  })

  it('closes cleanly with force=false when the drain finishes in budget', async () => {
    const c = fakeConsumer({ drainMs: 10 })
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 500 })

    expect(outcome.forced).toBe(false)
    expect(c.close).toHaveBeenCalledWith(false)
    expect(outcome.abandoned).toEqual([])
  })

  it('force-closes when the drain exceeds the budget', async () => {
    const c = fakeConsumer({ drainMs: 500 })
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 80 })

    expect(outcome.forced).toBe(true)
    expect(c.close).toHaveBeenCalledWith(true)
  })

  it('snapshots abandoned job IDs BEFORE force close', async () => {
    // close(true) can clear local active tracking, so reading active() after
    // forcing would report nothing and the IDs would be unrecoverable.
    const active: ActiveJob[] = [{ jobId: 'j-77', queue: 'q0', name: 'slow', startedAt: 1 }]
    const c = fakeConsumer({ drainMs: 500, active, clearActiveOnForce: true })
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 60 })

    expect(outcome.abandoned.map(j => j.jobId)).toEqual(['j-77'])
  })

  it('treats a rejecting drain() like a timeout: snapshots and force-closes', async () => {
    // Promise.all would short-circuit on the first rejection and skip
    // close() entirely, silently losing the abandoned job IDs. drain() must
    // be handled the same way as a timeout: snapshot, then force-close.
    const active: ActiveJob[] = [{ jobId: 'j-99', queue: 'q0', name: 'flaky', startedAt: 1 }]
    const c = fakeConsumer({ active })
    c.drain = vi.fn(async () => { throw new Error('driver connection dropped') })
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 500 })

    expect(outcome.forced).toBe(true)
    expect(outcome.abandoned.map(j => j.jobId)).toEqual(['j-99'])
    expect(c.close).toHaveBeenCalledWith(true)
    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
  })

  it('tolerates a rejecting pause() and still proceeds to a clean drain', async () => {
    // pause() is wrapped in allSettled precisely so one rejecting consumer
    // cannot abort the sequence for the others.
    const c = fakeConsumer({ drainMs: 5 })
    c.pause = vi.fn(async () => { throw new Error('pause exploded') })
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 500 })

    expect(outcome.forced).toBe(false)
    expect(c.close).toHaveBeenCalledWith(false)
  })

  it('deregisters and closes the driver on the clean path', async () => {
    const s = fakeSupervisor([fakeConsumer({ drainMs: 5 })])

    const outcome = await runDrain(s as never, { timeout: 500 })

    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
    expect(s.driver.close).toHaveBeenCalled()
    expect(outcome.deregistered).toBe(true)
  })

  it('deregisters even on the forced path', async () => {
    const s = fakeSupervisor([fakeConsumer({ drainMs: 500 })])

    await runDrain(s as never, { timeout: 50 })

    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
  })

  it('deregisters even when a step genuinely throws (active() blows up mid-snapshot)', async () => {
    // pause() and drain() are both wrapped in allSettled, so a rejection
    // there never reaches the outer catch — asserting against a throwing
    // pause() would pass even with the try/catch deleted entirely. active()
    // is called as a plain synchronous call while snapshotting abandoned
    // jobs, so a throwing active() is a genuine path into the catch block.
    const c = fakeConsumer({ drainMs: 500 })
    c.active = () => { throw new Error('active() blew up') }
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 50 })

    expect(outcome.forced).toBe(true)
    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
  })

  it('bounds a hanging close() by the shared deadline instead of waiting for it', async () => {
    // Both real drivers make close() blocking (bullmq: worker.close(force) +
    // redis.quit(); memory: polls while active). An unresponsive Redis must
    // not be able to hang here and starve deregistration.
    const c = fakeConsumer({ drainMs: 500 })
    c.close = vi.fn(async (force: boolean) => { if (force) await tick(5000) })
    const s = fakeSupervisor([c])

    const started = Date.now()
    const outcome = await runDrain(s as never, { timeout: 80 })
    const elapsed = Date.now() - started

    expect(outcome.forced).toBe(true)
    expect(elapsed).toBeLessThan(1000)
    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
  })

  it('a slow pause cannot consume the whole budget', async () => {
    // The deadline is computed once at entry and shared by every step. Under
    // the bug this protects against (each step getting a fresh 250ms budget
    // instead of a shared one), pause (200ms) + a fresh drain timeout
    // (250ms) would total ~450ms and still satisfy a loose "< 1000ms"
    // assertion, so the bound here is tight enough to actually fail on that
    // behaviour.
    const c = fakeConsumer({ pauseMs: 200, drainMs: 5000 })
    const s = fakeSupervisor([c])

    const started = Date.now()
    const outcome = await runDrain(s as never, { timeout: 250 })
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(400)
    expect(outcome.forced).toBe(true)
    expect(s.driver.deregister).toHaveBeenCalled()
  })

  it('sets state to draining as the very first state transition', async () => {
    const s = fakeSupervisor([fakeConsumer()])
    await runDrain(s as never, { timeout: 200 })

    // setState('stopped') also fires later; toHaveBeenCalledWith would match
    // regardless of order, so assert on the first call specifically.
    expect(s.setState.mock.calls[0]).toEqual(['draining'])
  })

  it('stops the heartbeat before deregistering', async () => {
    // A heartbeat tick landing between deregister() resolving and
    // driver.close() would re-write the worker record with a fresh TTL,
    // leaving a phantom worker in the registry after the process is gone.
    const s = fakeSupervisor([fakeConsumer({ drainMs: 5 })])

    await runDrain(s as never, { timeout: 500 })

    expect(s.stopHeartbeat).toHaveBeenCalled()
    const stopOrder = s.stopHeartbeat.mock.invocationCallOrder[0]!
    const deregisterOrder = s.driver.deregister.mock.invocationCallOrder[0]!
    expect(stopOrder).toBeLessThan(deregisterOrder)
  })

  it('reports deregistered: false when deregister() never resolves in time', async () => {
    const s = fakeSupervisor([fakeConsumer({ drainMs: 5 })])
    s.driver.deregister = vi.fn(() => new Promise(() => {}))

    const outcome = await runDrain(s as never, { timeout: 30 })

    expect(outcome.deregistered).toBe(false)
  })
})
