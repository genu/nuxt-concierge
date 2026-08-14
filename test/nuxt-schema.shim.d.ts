import type { Nitro, NitroConfig } from 'nitropack/types'

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
 * 1. `nuxt.hook('nitro:config', ...)` / `nuxt.hook('nitro:init', ...)`
 *    (`src/module.ts`, `src/templates.ts`) — without this, `'nitro:config'`
 *    is not a member of `HookKeys<NuxtHooks>` at all, and the callback
 *    parameter types accordingly to `any` via TS7006.
 */
declare module '@nuxt/schema' {
  interface NuxtHooks {
    'nitro:config': (nitroConfig: NitroConfig) => void | Promise<void>
    'nitro:init': (nitro: Nitro) => void | Promise<void>
  }

  /**
   * 2. `nuxt.options.runtimeConfig.concierge` (`src/module.ts`) — every real
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
