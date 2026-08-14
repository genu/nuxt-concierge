/**
 * `#imports` is a Nitro/Nuxt build-time virtual module (populated from the
 * generated `.nuxt`/nitro build context) — it never exists as a real package
 * on disk, so plain `tsc` (this project's `typecheck:tests`, run outside any
 * Nuxt/Nitro build) cannot resolve it on its own.
 *
 * `src/runtime/server/middleware/role-gate.ts` and
 * `src/runtime/server/routes/api/registry.ts` both import
 * `useRuntimeConfig` from it, and get pulled into this program because
 * `test/unit/role-gate.test.ts` and `test/unit/api/registry.test.ts` import
 * from them (those two tests `vi.mock('#imports', ...)` for the vitest
 * RUNTIME, which does nothing for the type checker — this file is `tsc`'s
 * equivalent).
 *
 * Typed to exactly the two fields `role-gate.ts` reads off `.concierge`, not
 * a duplicate of the real, generated `RuntimeConfig` type: this shim exists
 * only so that one call site resolves at all, not to re-typecheck
 * runtimeConfig's shape — that already happens for real under `pnpm
 * typecheck` (`nuxi typecheck playground`), which builds the actual
 * Nuxt/Nitro type graph. `registry.ts`'s own use of `useRuntimeConfig()`
 * goes through an `as unknown as ResolvedConciergeOptions` cast (see that
 * file) precisely so it does NOT depend on this shim's shape either.
 */
declare module '#imports' {
  export function useRuntimeConfig(): {
    concierge: {
      role: string | undefined
      isDev: boolean
    }
  }
}
