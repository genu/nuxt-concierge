import { describe, it, expect, vi } from 'vitest'
import { createSyncDriver } from '../../../src/runtime/server/drivers/sync'

describe('sync driver', () => {
  it('reports its capabilities honestly', () => {
    const d = createSyncDriver()
    expect(d.name).toBe('sync')
    expect(d.capabilities).toEqual({ persistent: false, crossProcess: false })
  })

  it('runs the handler inline during enqueue', async () => {
    const d = createSyncDriver()
    const seen: unknown[] = []
    d.registerHandler('mail', 'send', async ctx => { seen.push(ctx.payload) })
    await d.init()

    await d.enqueue('mail', { name: 'send', payload: { to: 'a@b.com' } })

    expect(seen).toEqual([{ to: 'a@b.com' }])
  })

  it('propagates handler errors to the caller of enqueue', async () => {
    const d = createSyncDriver()
    d.registerHandler('mail', 'send', async () => { throw new Error('boom') })
    await d.init()

    await expect(d.enqueue('mail', { name: 'send', payload: {} })).rejects.toThrow('boom')
  })

  it('round-trips the payload through the envelope so Dates survive', async () => {
    const d = createSyncDriver()
    let got: unknown
    d.registerHandler('q', 'j', async ctx => { got = ctx.payload })
    await d.init()

    await d.enqueue('q', { name: 'j', payload: { at: new Date('2026-01-01T00:00:00.000Z') } })

    expect((got as { at: Date }).at).toBeInstanceOf(Date)
  })

  it('throws when enqueueing a job with no registered handler', async () => {
    const d = createSyncDriver()
    await d.init()
    await expect(d.enqueue('q', { name: 'missing', payload: {} })).rejects.toThrow(/no handler/i)
  })

  it('has an inert consumer and an empty registry', async () => {
    const d = createSyncDriver()
    await d.init()
    const c = d.consume('q', { concurrency: 1 }, vi.fn())

    expect(c.activeCount()).toBe(0)
    expect(c.active()).toEqual([])
    await expect(c.pause()).resolves.toBeUndefined()
    await expect(c.drain()).resolves.toBeUndefined()
    await expect(d.workers()).resolves.toEqual([])
    await expect(d.depth('q')).resolves.toBe(0)
  })
})
