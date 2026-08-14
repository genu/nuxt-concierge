import { describe, expect, it } from 'vitest'
import { createSyncDriver } from '../../src/runtime/server/drivers/sync'
import { createMemoryDriver } from '../../src/runtime/server/drivers/memory'

/**
 * `sync`'s contract is ABSENCE, which is a stronger and different claim than
 * "calling it fails". A uniform interface whose sync implementation silently
 * no-ops would make "this driver cannot schedule" indistinguishable from
 * "there are no schedules", and the Schedules panel would render a confident
 * empty table that is a lie. Asserting the type-level fact at runtime means a
 * later "helpful" stub breaks this test rather than quietly changing what the
 * dashboard claims.
 */
describe('sync driver scheduling', () => {
  it('declares no scheduling at all', () => {
    expect(createSyncDriver().schedule).toBeUndefined()
  })
})

describe('enqueue result shape', () => {
  it('reports deduplicated:false when no dedup was requested — sync', async () => {
    const driver = createSyncDriver()
    driver.registerHandler('default', 'noop', async () => {})
    const result = await driver.enqueue('default', { name: 'noop', payload: {} })
    expect(result.deduplicated).toBe(false)
    expect(result.id).toEqual(expect.any(String))
  })

  it('reports deduplicated:false when no dedup was requested — memory', async () => {
    const driver = createMemoryDriver()
    const result = await driver.enqueue('default', { name: 'noop', payload: {} })
    expect(result.deduplicated).toBe(false)
    expect(result.id).toEqual(expect.any(String))
  })
})
