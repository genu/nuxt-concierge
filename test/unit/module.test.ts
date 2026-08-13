import { describe, it, expect } from 'vitest'
import type { Nuxt } from '@nuxt/schema'
import nuxtConciergeModule from '../../src/module'
import { resolveModuleOptions } from '../../src/options'

/**
 * Proves the actual production wiring, not `resolveModuleOptions` in
 * isolation. `defineNuxtModule` (from `@nuxt/kit`) attaches a `getOptions`
 * function to the module it returns, and that function runs the EXACT
 * `defu(inlineOptions, nuxtConfigOptions, optionsDefaults)` pre-merge that
 * `@nuxt/kit` performs before `setup()` is ever called — see
 * `_defineNuxtModule` in `@nuxt/kit`'s `src/module/define.ts`. Calling it
 * directly, with a minimal fake `Nuxt`, exercises the real merge chain
 * without booting a full Nuxt instance (no dev server, no build).
 *
 * This is the regression the whole-branch review flagged: `src/module.ts`
 * used to also pass `defaults: moduleDefaults` to `defineNuxtModule`, which
 * became `optionsDefaults` here and got deep-merged with the user's
 * `worker.queues` by `defu` — before `resolveModuleOptions` ever ran — so
 * `resolveModuleOptions`'s "replace, don't merge" branch always received an
 * already-merged map and its guarantee never fired in the real module path.
 * `test/unit/options.test.ts`'s replacement assertions could not catch this:
 * they call `resolveModuleOptions` directly with raw user options, which is
 * not what production supplies it.
 */
describe('the module option resolution @nuxt/kit actually performs', () => {
  it('getOptions() does not reintroduce the default queue map behind a user-declared replacement', async () => {
    const fakeNuxt = {
      options: {
        // What a user's `nuxt.config.ts` would set under the module's
        // `configKey` ("concierge") — this is `nuxtConfigOptions` in
        // `@nuxt/kit`'s merge chain, not `inlineOptions`.
        concierge: { worker: { queues: { mail: 2 } } },
      },
    } as unknown as Nuxt

    const preMerged = await nuxtConciergeModule.getOptions!({}, fakeNuxt)

    // BEFORE this fix: `defineNuxtModule({ defaults: moduleDefaults })` made
    // this `defu({}, { worker: { queues: { mail: 2 } } }, moduleDefaults)`,
    // which deep-merges objects — so `preMerged.worker.queues` would be
    // `{ mail: 2, default: 5 }` here, and the `default` queue would silently
    // survive into `setup()`.
    expect(Object.keys(preMerged.worker?.queues ?? {})).toEqual(['mail'])

    // `resolveModuleOptions` then runs on what `setup()` actually receives —
    // genuinely partial options, for the first time in the real module path.
    const resolved = resolveModuleOptions(preMerged)
    expect(Object.keys(resolved.worker.queues)).toEqual(['mail'])
    expect(resolved.worker.queues).toEqual({ mail: 2 })
  })

  it('does not pass `defaults` to defineNuxtModule, keeping resolveModuleOptions the single resolution point', async () => {
    const fakeNuxt = { options: {} } as unknown as Nuxt

    // With no `defaults` on the module and no user config at all, getOptions
    // has nothing to merge — proving the module itself no longer supplies a
    // second, competing set of defaults.
    const preMerged = await nuxtConciergeModule.getOptions!({}, fakeNuxt)
    expect(preMerged).toEqual({})
  })
})
