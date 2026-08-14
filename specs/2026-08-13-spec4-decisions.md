# Spec 4 decisions record

Distilled from the spec 4 execution ledger (14 tasks, each with an independent review and fix
loop). The design spec says what was intended; this says what was decided along the way, what
was deliberately left undone, and which facts were expensive to learn.

Read this, alongside the [phase 1](2026-08-13-phase1-decisions.md) and
[spec 3](2026-08-13-spec3-decisions.md) records, before starting spec 5.

## Constraints that will break the build or silently break behaviour

- **`build:client` must run LAST in both `prepack` and `dev:prepare`, never first.**
  `nuxt-module-build` wraps unbuild, whose default `clean: true` does
  `fs.rm(dist, { recursive: true, force: true })` on the whole top-level `dist/` before
  recreating only `dist/module.mjs` and `dist/runtime`. `pnpm build:client && nuxt-module-build
  build` therefore builds the dashboard SPA and deletes it moments later — confirmed empirically
  in an isolated copy, not assumed. The failure is silent: no script errors, the tarball just
  ships with no `dist/client`, and every consumer gets a 404 at the DevTools tab. Nothing but a
  CI step that inspects the built tarball can catch a regression here, which is why one now
  exists (`.github/workflows/ci.yml`, after `prepack`, asserting `dist/client` is present).
  The design doc's own "Build and ship pipeline" table showed the dangerous order for several
  tasks after it was fixed in code — a live landmine, since a reader would copy it straight back
  into `package.json`. Fixed in this task.

- **Registration-time gating is the dashboard's entire security boundary.** The dashboard's API
  routes, static assets, and DevTools tab are registered only inside `if (nuxt.options.dev)` in
  `src/module.ts`'s `setup()` — decided once, at build time, by whoever built the artifact. There
  is deliberately no runtime flag, environment variable, or config option that re-enables it in
  production (the old `managementUI` boolean is exactly the shape this replaces, and it is gone).
  Anyone "helpfully" adding one has removed the reason this spec needs no auth of its own: a
  queue dashboard with a retry button and no auth is only safe because it provably cannot be
  reached outside a local dev server.

- **BullMQ's `getJobs` applies one numeric range to every state key independently, not to a
  globally-ordered merged sequence.** `bullmq.ts`'s `introspect.list()` must therefore always
  pass Redis range start `0` (never `page.offset`) and apply both `offset` and `limit` locally,
  after concatenating — mirroring `memory.ts`'s own `all.slice(offset, offset + limit)`. Passing
  `page.offset` as the range start instead looks like a reasonable "avoid the over-fetch"
  optimization and is actively wrong: with `waiting = ['wait', 'prioritized']` and 15 wait + 10
  prioritized rows, it skips every prioritized job on every page while `total` still counts them.
  Confirmed by two rounds of review against the installed `bullmq@5.63.0` Lua source, including
  a strictly-worse regression introduced by an imprecise fix instruction along the way. This is
  also why `jobs-list.ts`'s `MAX_LIMIT = 100` exists: it is what makes the over-fetch (up to
  `offset + limit` rows per state, per page) cheap enough to accept, and why `offset` itself has
  no ceiling — a large `offset` costs Redis roughly the queue's real size, not the offset value,
  *only as long as the range start stays 0*. `jobs-list.ts` now carries a comment cross-referencing
  this invariant so a future "optimization" here does not silently reintroduce the bug.

- **The dev dashboard's driver reads must be timeout-bounded, or a dead Redis hangs every panel
  forever instead of showing the unhealthy state the spec requires.** BullMQ's ioredis connections
  are constructed with `maxRetriesPerRequest: null` (required for blocking commands), so a command
  issued while disconnected sits in ioredis's offline queue and never settles — not rejects,
  never resolves at all. `driver.isHealthy()` is not a safe gate on its own: it is driven off
  ioredis's `error`/`ready` events and can still read `true` while an individual command hangs.
  `introspect.ts`'s `withTimeoutOrThrow`/`withTimeout` (1.5s default, `DRIVER_READ_TIMEOUT_MS`)
  race every driver read across `/overview` and all three job routes against this. Found twice in
  the same task — first in `buildOverview`, then again in the job list/detail/retry routes, which
  have the identical unbounded read over the identical connection. `JobsPanel`'s only other
  degradation signal is `overview.introspectable`, which for bullmq stays `true` throughout an
  outage — so without the timeout, a dead Redis presents as a silently empty job list, not an
  explained one.

## Corrections to earlier claims

- **The memory driver's `list()` used to over-disclose.** `listByState` mapped terminal records
  through `toDetail()`, which returns a full `JobDetail` (raw devalue envelope and stack) even
  though `JobSummary` — the declared contract for a list row — has neither. The client never read
  the extra fields, but the wire response shipped raw payload content for every row of every list,
  which is exactly the content-exposure the envelope's shape-only error messages exist to prevent
  elsewhere. Now projects explicitly to `JobSummary`.

- **`decodePayload`'s final catch used to leak malformed payload content verbatim.** devalue's
  `parse` delegates to `JSON.parse`, whose `SyntaxError` quotes the offending text back
  (`Unexpected token 'o', "the-actual-payload" is not valid JSON`) — and the bullmq driver turns
  this message into an `UnrecoverableError`, which BullMQ persists as `failedReason` in Redis and
  also logs. Fixed to report `err.name` (a fixed string from a closed set) plus `payloadLength`
  instead. `test/unit/envelope.test.ts` now has a direct case for this (`decodePayload({ v: 1,
  payload: 'not-devalue-at-all' })`), not just indirect coverage through the API-layer wrapper —
  `sync`, `memory` and `bullmq` all call `decodePayload` directly.

- **`test/lifecycle/globalSetup.ts`'s env-propagation comment understated the guarantee.** It read
  as `forks`-pool-specific. The real mechanism, confirmed against vitest 4.1.10's installed
  source, is pool-agnostic: vitest spreads `{ ...process.env }` into each worker's env at
  dispatch time, which happens after `globalSetup` has already run and mutated it. Changing
  `pool` in `vitest.lifecycle.config.ts` does not make this fragile; the comment is corrected.

## Known gaps, deliberately carried

- **The `memory` driver's dashboard history is bounded and not durable**, by design.
  `concierge.memory.historyLimit` (default 100 terminal-state jobs per queue, evicted
  oldest-first) exists solely so the dev dashboard has something to show — it is not a durability
  knob, and a process restart loses it exactly as it loses every other piece of `memory` driver
  state. `capabilities.history: 'bounded'` (vs. `bullmq`'s `'durable'`) is what lets the UI say so
  rather than implying completeness.
- **The dashboard is dev-only, full stop.** There is no way to run it against a production build,
  by design (see above). Anyone filing this as a bug has misread the spec.
- **Cron is still not in this release** (carried from phase 1 / spec 3; unaffected by spec 4).

## Facts that cost real time to establish

- **Nitro's `publicAssets` at a given `baseURL` shadows sibling server routes under that same
  prefix — it does not fall through.** Registering the dashboard SPA's static assets at bare
  `/_concierge` made `GET /_concierge/health` 404 in dev, confirmed by direct experiment. It also
  would have shadowed every `/_concierge/api/**` route added later. Fixed by moving the SPA to
  `/_concierge/ui`, which the design had already named as the pre-authorized fallback for exactly
  this outcome.
- **`nuxt.options.devServer.url` is not yet correct inside `setup()`.** It logs the default port
  (3000) even when the dev server actually binds elsewhere, because `setup()` runs before the
  server listens. Fixed by logging "open the Concierge tab in Nuxt DevTools" instead of a URL —
  there is no URL to visit directly in the first place, since the dashboard only makes sense
  inside the DevTools iframe.
- **Nuxt's dev server binds only IPv6 loopback (`::1`) by default.** The lifecycle harness's
  dev-server scenario targeted `127.0.0.1` and would have timed out on every case until launched
  with `--host 127.0.0.1` explicitly. Tenth and last plan defect found in this spec's own
  reference code.
- **`src/module.ts` and `src/templates.ts` were never covered by `pnpm typecheck`.** `nuxi
  typecheck playground`'s generated app/server tsconfigs only `include` `src/runtime` (and a few
  other subtrees) — not the module entry files themselves. This task's `typecheck:tests` pulls
  them into a program for the first time (via `test/unit/module.test.ts`'s real import), and it
  surfaced two previously-invisible gaps: `nuxt.hook('nitro:config' | 'nitro:init', ...)` isn't
  a known `NuxtHooks` member without `@nuxt/nitro-server`'s type augmentation (which a real
  consuming app's generated `.nuxt/nuxt.d.ts` supplies for free, and this module's own bare `tsc`
  run does not), and `nuxt.options.runtimeConfig.concierge` resolves to `unknown` for the same
  reason (a real app's generated `runtime-config.d.ts` infers it from the app's own config; this
  module's own sources have nothing to infer from). Both are bridged with a narrow, well-commented
  ambient shim under `test/` (`test/nuxt-schema.shim.d.ts`) rather than by touching production
  code or loosening `test/tsconfig.json`'s strictness — the gap is an artifact of typechecking
  outside a real Nuxt build, not a bug in `src/module.ts` itself.
- **`#imports` (the Nitro virtual module) has the same problem, for the same reason.**
  `src/runtime/server/middleware/role-gate.ts` and `.../routes/api/registry.ts` both import
  `useRuntimeConfig` from it; their own tests already `vi.mock('#imports', ...)` for the vitest
  *runtime*, which does nothing for `tsc`. Bridged the same way, in `test/imports.shim.d.ts`.

## Test-suite conventions established

Extending the phase 1 and spec 3 conventions, which still hold.

- **`typecheck:tests` (`tsc --noEmit -p test/tsconfig.json`) covers `test/**/*.ts`** at the same
  strictness as the root config, closing #26. It is a genuine third program, distinct from
  `typecheck` (playground) and `typecheck:public` (`test/types`) — a mock-heavy test can pass
  `vitest run` while carrying type errors a runtime assertion cannot see (a `vi.fn()` spy accepts
  any call shape regardless of the real signature).
- **A `tsc`-only ambient shim is not "loosening the shared config."** `test/*.shim.d.ts` files
  declare module augmentations for things that are real in every actual Nuxt build (`#imports`,
  `NuxtHooks['nitro:config'/'nitro:init']`, `RuntimeConfig['concierge']`) but only absent because
  this module's own sources are being typechecked outside of one. This is different in kind from
  weakening `strict`, adding `any`, or disabling a check — the shim documents an environment gap
  and closes it with an honest (if loose) type, and every use is commented with why.
- **CI must assert the tarball, not just build it.** `npm pack --dry-run | grep -q dist/client`
  after `prepack` is a real failing assertion, added specifically because the build-order landmine
  above produces no error of its own — the only symptom is an empty directory in a tarball nobody
  inspects before publishing.

## Process note

Spec 4 ran as 14 tasks, each with an independent review and fix loop. Ten defects were found
originating in the plan's own reference code, not in execution — consistent with phase 1 and
spec 3's experience, and the same lesson stated a third time: a detailed plan is not the same
thing as a correct one. Two tasks (2 and 3) were merged into one dispatch for the same reason
spec 3 merged a pair — splitting retention from exposure produced a task that could not end
green alone.

**The dev-server lifecycle scenario (Task 13) is the only end-to-end coverage this feature can
have**, because the dashboard exists only in dev — there is no production deployment of it to
smoke-test. If it becomes flaky, fix it rather than skipping it: skipping it removes all
end-to-end signal for the module's most user-visible feature, not just one test among many.
