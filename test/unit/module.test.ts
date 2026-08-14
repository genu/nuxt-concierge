import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Nuxt } from '@nuxt/schema'
import { runWithNuxtContext } from '@nuxt/kit'
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

interface FakeNitroConfig {
  publicAssets?: Array<{ dir: string, baseURL?: string, maxAge?: number }>
}

/**
 * A fake Nuxt sufficient for setup() to run: the module's own kit calls are
 * mocked below, so this records WHAT the module registers rather than
 * booting Nuxt. `hook` records callbacks by name instead of being a no-op
 * `vi.fn()`, so a test can later invoke the `nitro:config` callback the
 * module registers and inspect what it mutated — the whole point of the
 * `dev: false` half is proving that callback was never registered at all,
 * which a no-op recorder could not distinguish from "registered but empty".
 */
const makeNuxt = (dev: boolean) => {
  const hookCallbacks: Record<string, Array<(...args: never[]) => unknown>> = {}

  return {
    // The module declares `meta.compatibility`, so calling it directly (it
    // is itself the callable `setup`, per @nuxt/kit's `NuxtModule` type —
    // see the comment at each call site below) runs
    // `checkNuxtCompatibility`, which reads `nuxt._version`. Omitting it
    // throws `NUXT_B8005` before `setup()` itself ever runs.
    _version: '4.5.2',
    options: {
      dev,
      rootDir: process.cwd(),
      buildDir: `${process.cwd()}/.nuxt`,
      // `templates`/`vite.vue` are read by @nuxt/kit's real (unmocked)
      // `addTemplate`/`addTypeTemplate` — `createTemplateNuxtPlugin` and
      // `createTemplateInternalTypes`, both called before the dashboard
      // block in `setup()`, exercise them for real rather than being mocked.
      build: { transpile: [] as string[], templates: [] as unknown[] },
      vite: { vue: {} as Record<string, unknown> },
      runtimeConfig: {} as Record<string, unknown>,
      devServer: { url: 'http://localhost:3000' },
      nitro: {} as FakeNitroConfig,
    },
    hook: vi.fn((name: string, cb: (...args: never[]) => unknown) => {
      hookCallbacks[name] ??= []
      hookCallbacks[name].push(cb)
    }),
    hooks: { hook: vi.fn() },
    // Not part of the real Nuxt interface — a test-only escape hatch to run
    // whatever the module registered under a given hook name, the way Nitro
    // itself would when it actually reaches that phase.
    async callHook(name: string, ...args: never[]) {
      for (const cb of hookCallbacks[name] ?? []) await cb(...args)
    },
  }
}

const handlers: Array<{ route?: string, middleware?: boolean, method?: string }> = []
const customTabs: unknown[] = []

vi.mock('@nuxt/kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nuxt/kit')>()
  return {
    ...actual,
    addServerHandler: vi.fn((h: { route?: string, middleware?: boolean, method?: string }) => { handlers.push(h) }),
    addServerPlugin: vi.fn(),
    useLogger: () => ({ success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }
})

vi.mock('@nuxt/devtools-kit', () => ({
  addCustomTab: vi.fn((tab: unknown) => { customTabs.push(tab) }),
}))

describe('dashboard registration is gated on nuxt.options.dev at build time', () => {
  beforeEach(() => {
    handlers.length = 0
    customTabs.length = 0
  })

  it('registers the DevTools tab and the client publicAssets dir in dev', async () => {
    const nuxt = makeNuxt(true)
    // The exported module is itself the callable `setup` (a NuxtModule),
    // not an object with a `.setup` member — `nuxtConciergeModule.setup` is
    // undefined at runtime, so it is called directly here. Wrapped in
    // `runWithNuxtContext` because `scanJobs()` (called early in `setup()`)
    // reads `useNuxt()`, which is otherwise unavailable outside a real Nuxt
    // instance's module-loading context.
    await runWithNuxtContext(nuxt as unknown as Nuxt, () => nuxtConciergeModule({}, nuxt as unknown as Nuxt))

    expect(customTabs).toHaveLength(1)

    const nitroConfig: FakeNitroConfig = {}
    await nuxt.callHook('nitro:config', nitroConfig as never)

    expect(nitroConfig.publicAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baseURL: '/_concierge/ui',
          dir: expect.stringContaining('dist/client'),
        }),
      ]),
    )

    // The tab's iframe `src` is the ONLY consumer of the publicAssets
    // baseURL above — nothing else in the runtime reads it. A regression
    // to a bare `/_concierge/` here (shadowing every sibling server route,
    // see the test below) would 404 into a blank iframe, detectable only in
    // a browser, which this branch has never used. Asserted against the
    // SAME test that already asserts the baseURL, so the two cannot drift
    // apart without a failing test.
    const [tab] = customTabs as Array<{ view: { src: string } }>
    expect(tab?.view.src).toBe('/_concierge/ui/')
  })

  it('registers the client publicAssets under /_concierge/ui, NOT bare /_concierge, so it cannot shadow sibling server routes', async () => {
    const nuxt = makeNuxt(true)
    // The exported module is itself the callable `setup` (a NuxtModule),
    // not an object with a `.setup` member — `nuxtConciergeModule.setup` is
    // undefined at runtime, so it is called directly here. Wrapped in
    // `runWithNuxtContext` because `scanJobs()` (called early in `setup()`)
    // reads `useNuxt()`, which is otherwise unavailable outside a real Nuxt
    // instance's module-loading context.
    await runWithNuxtContext(nuxt as unknown as Nuxt, () => nuxtConciergeModule({}, nuxt as unknown as Nuxt))

    const nitroConfig: FakeNitroConfig = {}
    await nuxt.callHook('nitro:config', nitroConfig as never)

    // Confirmed by direct experiment against a real running Nitro dev server
    // (not assumed): registering the client's static assets at baseURL
    // `/_concierge` made `GET /_concierge/health` return 404 — the public
    // asset middleware shadows every sibling route under that same prefix
    // rather than falling through to it. `/_concierge/ui` is a strict
    // sub-path of `/_concierge`, so `/_concierge/health` and the
    // `/_concierge/api/**` routes Tasks 8-10 add are siblings of `ui/`, not
    // descendants of it, and nothing shadows them.
    const [asset] = nitroConfig.publicAssets ?? []
    expect(asset?.baseURL).toBe('/_concierge/ui')
    expect('/_concierge/health'.startsWith(`${asset?.baseURL}/`)).toBe(false)
  })

  it('registers NEITHER the tab NOR the publicAssets entry outside dev, while keeping health', async () => {
    const nuxt = makeNuxt(false)
    // The exported module is itself the callable `setup` (a NuxtModule),
    // not an object with a `.setup` member — `nuxtConciergeModule.setup` is
    // undefined at runtime, so it is called directly here. Wrapped in
    // `runWithNuxtContext` because `scanJobs()` (called early in `setup()`)
    // reads `useNuxt()`, which is otherwise unavailable outside a real Nuxt
    // instance's module-loading context.
    await runWithNuxtContext(nuxt as unknown as Nuxt, () => nuxtConciergeModule({}, nuxt as unknown as Nuxt))

    // The half that matters. A dashboard reachable in production is what
    // this spec's whole structure exists to prevent, and nothing else in
    // this plan can see it.
    expect(customTabs).toHaveLength(0)

    const nitroConfig: FakeNitroConfig = {}
    await nuxt.callHook('nitro:config', nitroConfig as never)
    expect(nitroConfig.publicAssets).toBeUndefined()

    // Health is NOT part of the dashboard — it is the production readiness
    // probe (gated by role, not by dev) and must survive under both halves.
    expect(handlers.some(h => h.route === '/_concierge/health')).toBe(true)

    // The dashboard's API routes are dev-only, gated at registration time —
    // no runtime flag or env var may re-enable them in production.
    expect(handlers.some(h => h.route?.startsWith('/_concierge/api'))).toBe(false)
  })

  it('does not write jobFiles or generatedTypesPath into runtimeConfig outside dev', async () => {
    const nuxt = makeNuxt(false)
    await runWithNuxtContext(nuxt as unknown as Nuxt, () => nuxtConciergeModule({}, nuxt as unknown as Nuxt))

    // These are ABSOLUTE build-machine paths. Baking them into a production
    // runtimeConfig would ship one developer's directory layout to every
    // deployment — this is the whole reason the registry endpoint's plumbing
    // lives inside the `nuxt.options.dev` block rather than beside the rest
    // of the resolved options.
    const concierge = (nuxt.options.runtimeConfig as { concierge?: Record<string, unknown> }).concierge
    expect(concierge?.jobFiles).toBeUndefined()
    expect(concierge?.generatedTypesPath).toBeUndefined()
  })

  it('writes jobFiles and generatedTypesPath into runtimeConfig in dev', async () => {
    const nuxt = makeNuxt(true)
    await runWithNuxtContext(nuxt as unknown as Nuxt, () => nuxtConciergeModule({}, nuxt as unknown as Nuxt))

    const concierge = (nuxt.options.runtimeConfig as { concierge?: Record<string, unknown> }).concierge
    // No jobs under this fake rootDir's server/jobs, so an empty map — but
    // present (an object), which is the point: it is written at all in dev.
    expect(concierge?.jobFiles).toEqual({})
    expect(concierge?.generatedTypesPath).toBe(`${nuxt.options.buildDir}/types/concierge-jobs.d.ts`)
  })

  it('still registers the health route in dev', async () => {
    const nuxt = makeNuxt(true)
    // The exported module is itself the callable `setup` (a NuxtModule),
    // not an object with a `.setup` member — `nuxtConciergeModule.setup` is
    // undefined at runtime, so it is called directly here. Wrapped in
    // `runWithNuxtContext` because `scanJobs()` (called early in `setup()`)
    // reads `useNuxt()`, which is otherwise unavailable outside a real Nuxt
    // instance's module-loading context.
    await runWithNuxtContext(nuxt as unknown as Nuxt, () => nuxtConciergeModule({}, nuxt as unknown as Nuxt))

    expect(handlers.some(h => h.route === '/_concierge/health')).toBe(true)

    // The overview endpoint is the first entry in API_HANDLERS — it must
    // actually be registered in dev, not merely present in the map.
    expect(handlers.some(h => h.route?.startsWith('/_concierge/api'))).toBe(true)
  })

  it('constrains the retry route to POST and every other API route to GET', async () => {
    const nuxt = makeNuxt(true)
    await runWithNuxtContext(nuxt as unknown as Nuxt, () => nuxtConciergeModule({}, nuxt as unknown as Nuxt))

    // A dev server is reachable from any page a developer happens to visit —
    // without this, `GET /_concierge/api/queues/:q/jobs/:id/retry` would
    // perform the retry, a side effect landing from a plain navigation.
    const retry = handlers.find(h => h.route === '/_concierge/api/queues/:queue/jobs/:id/retry')
    expect(retry?.method).toBe('post')

    const reads = handlers.filter(h =>
      h.route?.startsWith('/_concierge/api') && h.route !== '/_concierge/api/queues/:queue/jobs/:id/retry',
    )
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every(h => h.method === 'get')).toBe(true)
  })

  it('no longer registers the bull-board routes or transpiles its packages', async () => {
    const nuxt = makeNuxt(true)
    // The exported module is itself the callable `setup` (a NuxtModule),
    // not an object with a `.setup` member — `nuxtConciergeModule.setup` is
    // undefined at runtime, so it is called directly here. Wrapped in
    // `runWithNuxtContext` because `scanJobs()` (called early in `setup()`)
    // reads `useNuxt()`, which is otherwise unavailable outside a real Nuxt
    // instance's module-loading context.
    await runWithNuxtContext(nuxt as unknown as Nuxt, () => nuxtConciergeModule({}, nuxt as unknown as Nuxt))

    expect(nuxt.options.build.transpile).toEqual([])
    expect(handlers.some(h => h.route === '/_concierge')).toBe(false)
    expect(handlers.some(h => h.route === '/_concierge/**')).toBe(false)
  })
})
