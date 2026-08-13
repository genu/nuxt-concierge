import { describe, it, expectTypeOf } from 'vitest'

/**
 * Guards the harness itself, not the library. If `pnpm test:types` ever
 * passes while `typecheck.enabled` is false or the include glob has stopped
 * matching, every other assertion in test/types/ becomes vacuous and no
 * failure appears anywhere. Deleting the @ts-expect-error below must break
 * the run.
 */
describe('type-test harness', () => {
  it('evaluates positive assertions', () => {
    expectTypeOf<string>().toEqualTypeOf<string>()
  })

  it('evaluates negative assertions', () => {
    // @ts-expect-error string is not number
    expectTypeOf<string>().toEqualTypeOf<number>()
  })
})
