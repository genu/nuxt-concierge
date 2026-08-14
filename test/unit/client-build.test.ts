import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import fg from 'fast-glob'

const DIST = resolve(import.meta.dirname, '../../dist/client')

/**
 * Guards the SHIPPED artifact, not the source. `files: ["dist"]` publishes
 * whatever is in dist, and `prepack` is the only thing that builds the client —
 * so a broken client build would otherwise be discovered by a consumer rather
 * than by CI.
 *
 * This test only runs `pnpm build:client` standalone, so it cannot catch a
 * script-ordering regression in the root `package.json`. Both `prepack` and
 * `dev:prepare` MUST run `build:client` LAST, after `nuxt-module-build`, not
 * before: `nuxt-module-build build`/`build --stub` delegates to `unbuild`,
 * whose default `clean: true` removes the ENTIRE top-level `dist` (not just
 * the files it manages) before rebuilding `dist/module.mjs` and
 * `dist/runtime`. Running `build:client` first means that clean deletes
 * `dist/client` right after it's written, leaving nothing to rebuild it —
 * a published tarball with no dashboard, and a 404 at the DevTools tab on a
 * fresh clone. `nuxt-module-build prepare` does not touch `dist` (it's
 * Nuxt's own `prepare` command against the playground's `.nuxt`), so putting
 * `build:client` after it, not necessarily last-of-all, would also be safe —
 * but ordering it last of the whole chain is simplest to reason about and
 * verify empirically (`pnpm prepack && ls dist/client/index.html`).
 */
describe('the built dashboard client', () => {
  it('emits an index.html', () => {
    expect(existsSync(resolve(DIST, 'index.html'))).toBe(true)
  })

  it('references only relative asset paths', () => {
    const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')
    // Served from /_concierge/ as public assets, so absolute /assets/... paths
    // would resolve against the HOST app's root and 404. This is the failure
    // that presents as a blank panel with no server error.
    expect(html).not.toMatch(/(src|href)="\//)
    expect(html).toMatch(/(src|href)="\.\//)
  })

  it('stays within the bundle size budget', async () => {
    const files = await fg('**/*.{js,css}', { cwd: DIST, absolute: true })
    expect(files.length).toBeGreaterThan(0)
    const total = files.reduce((n, f) => n + statSync(f).size, 0)

    // Ceiling set from the FIRST real measurement, not invented. Measured
    // 391,841 bytes (.js + .css) on 2026-08-14 with @nuxt/ui 4.10.0, vue
    // 3.5.41, tailwindcss 4.3.3, vite 8.2.1. 550,000 is ~1.4x that, so a
    // dependency bump that doubles the bundle fails CI rather than arriving
    // silently in a consumer's node_modules.
    const CLIENT_SIZE_BUDGET_BYTES = 550_000
    expect(total).toBeLessThan(CLIENT_SIZE_BUDGET_BYTES)
  })
})
