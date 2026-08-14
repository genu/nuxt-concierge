import { describe, it, expect } from 'vitest'
import { createSyncDriver } from '../../src/runtime/server/drivers/sync'

/**
 * The `sync` driver's contract is ABSENCE, which is a stronger and different
 * claim than "calling it fails". A uniform interface returning empty arrays
 * would make "unsupported" indistinguishable from "genuinely empty", and the
 * UI would render a confident empty table that is a lie. This asserts the
 * type-level fact at runtime so a later "helpful" stub implementation breaks
 * this test rather than silently changing what the dashboard shows.
 */
describe('sync driver introspection', () => {
  it('declares no introspection at all', () => {
    const driver = createSyncDriver()
    expect(driver.introspect).toBeUndefined()
  })

  it('reports no history rather than an empty history', () => {
    const driver = createSyncDriver()
    expect(driver.capabilities.history).toBe('none')
  })
})
