/**
 * Two gaps that only exist because `typecheck:tests` runs `src/module.ts` and
 * `src/templates.ts` through PLAIN `tsc`, outside any real Nuxt/Nitro build —
 * something `pnpm typecheck` (`nuxi typecheck playground`) never did before
 * this task, since neither file was in that program's `include` list. A real
 * consuming app's `.nuxt/nuxt.d.ts` supplies both of these for free (a
 * `/// <reference>` to `@nuxt/nitro-server`'s hook augmentation, and a
 * generated `runtime-config.d.ts` inferred from the app's own config); a bare
 * `tsc` run over this module's own sources has neither.
 *
 * Deliberately NOT `import type { Nitro, NitroConfig } from 'nitropack/types'`.
 * That was tried and rejected: it resolves only because `.npmrc` commits
 * `shamefully-hoist=true`, and declaring `nitropack` as an explicit dependency
 * to make the import resolve without the hoist flag makes pnpm re-resolve the
 * unrelated `docs` workspace onto an older vite. Worse, `skipLibCheck: true`
 * (set on every generated tsconfig here) suppresses TS2307 *inside* `.d.ts`
 * files, so if the hoist flag were ever removed this import would not error —
 * it would silently degrade every type below to `any`. The minimal structural
 * types below cover only what the call sites actually read, so there is
 * nothing left to resolve against `nitropack` at all:
 *
 * - `nitro:config`'s `nitroConfig` — `src/module.ts` reads/writes
 *   `nitroConfig.publicAssets`; `src/templates.ts` reads `nitroConfig.alias`.
 * - `nitro:init`'s `nitro` — `src/module.ts` reads `nitro.options.runtimeConfig`
 *   and `nitro.options.preset`.
 *
 * `export {}` below is load-bearing, not decorative: without at least one
 * top-level import/export, TypeScript treats this file as a global SCRIPT
 * rather than a module, and a script-mode `declare module '@nuxt/schema'`
 * stops MERGING with the package's own ambient declarations — it replaces
 * them outright, which is what broke `import type { Nuxt } from
 * '@nuxt/schema'` elsewhere in this program the moment the `nitropack/types`
 * import (which made this file a module as a side effect) was removed.
 */
export {}

interface MinimalNitroConfig {
  publicAssets?: Array<{ dir: string, baseURL?: string, maxAge?: number }>
  alias?: Record<string, string>
}

interface MinimalNitro {
  options: {
    runtimeConfig?: Record<string, unknown>
    preset?: string
  }
}

declare module '@nuxt/schema' {
  interface NuxtHooks {
    'nitro:config': (nitroConfig: MinimalNitroConfig) => void | Promise<void>
    'nitro:init': (nitro: MinimalNitro) => void | Promise<void>
  }

  /**
   * `nuxt.options.runtimeConfig.concierge` (`src/module.ts`) — every real
   * consuming app gets this key typed for free, inferred from whatever it
   * assigns at config time. This module's OWN sources have nothing to infer
   * from at typecheck time (there is no consuming app here), so without this,
   * `.concierge` resolves to `unknown` and every `defu(..., concierge)` call
   * in `src/module.ts` fails with "Argument of type 'unknown' is not
   * assignable to parameter of type 'IgnoredInput | Input'". Loose
   * (`Record<string, unknown>`), not `ResolvedConciergeOptions`, because at
   * each call site in `src/module.ts` the value is genuinely a partial,
   * still-being-built-up object (jobFiles-only, then role/version-only, then
   * fully resolved) — narrower would just move the mismatch to a different
   * line instead of removing it.
   */
  interface RuntimeConfig {
    concierge: Record<string, unknown>
  }
}
