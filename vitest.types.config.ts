import { defineConfig } from 'vitest/config'

/**
 * Type-level tests, run separately from `pnpm test`.
 *
 * Spec 3's deliverable is types, and a runtime suite cannot see them: every
 * one of phase 1's 179 unit tests would still pass if codegen emitted `any`
 * for every job. `include: []` is deliberate — this project contributes no
 * runtime tests, only `typecheck.include`.
 */
export default defineConfig({
  test: {
    include: [],
    typecheck: {
      enabled: true,
      only: true,
      include: ['test/types/**/*.test-d.ts'],
      tsconfig: './test/types/tsconfig.vitest.json',
    },
  },
})
