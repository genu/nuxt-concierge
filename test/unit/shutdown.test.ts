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

  it('deregisters even when pause throws', async () => {
    const c = fakeConsumer()
    c.pause = vi.fn(async () => { throw new Error('pause exploded') })
    const s = fakeSupervisor([c])

    await runDrain(s as never, { timeout: 200 })

    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
  })

  it('a slow pause cannot consume the whole budget', async () => {
    // The deadline is computed once at entry and shared by every step, so a
    // slow pause() leaves no time for drain but still leaves the finally block
    // reachable.
    const c = fakeConsumer({ pauseMs: 200, drainMs: 5000 })
    const s = fakeSupervisor([c])

    const started = Date.now()
    const outcome = await runDrain(s as never, { timeout: 250 })
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(1000)
    expect(outcome.forced).toBe(true)
    expect(s.driver.deregister).toHaveBeenCalled()
  })

  it('sets state to draining at entry', async () => {
    const s = fakeSupervisor([fakeConsumer()])
    await runDrain(s as never, { timeout: 200 })
    expect(s.setState).toHaveBeenCalledWith('draining')
  })
})
