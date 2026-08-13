# Phase 1 decisions record

Distilled from the phase 1 execution ledger. The design spec says what was intended; this says
what was decided along the way, what was deliberately left undone, and which facts were
expensive to learn.

Read this before starting spec 3. The first section is build-breaking if violated.

## Constraints that will break the build or silently break behaviour

- **Resolve scan paths against `nuxt.options.rootDir`, never `srcDir`.** Nuxt 4 defaults
  `srcDir` to `app/`, so `resolve(srcDir, 'server/...')` yields `app/server/...`, which does not
  exist — the scan returns `[]` and raises nothing. `server/` sits at the root in both v3 and
  v4. *(Credit: PR #10 by @gsxdsm.)*
- **Never import `defineNitroPlugin` from `#imports`** in a generated nitro plugin; it breaks
  resolution, notably with Prisma. The wrapper is also unnecessary — it is an identity function,
  so the generated plugin exports a bare default function instead.
- **The generated `.ts` plugin is parsed as plain JavaScript before any TypeScript transform.**
  Zero TS syntax survives in the emitted template. Typing is done via the
  `defineConciergePlugin` contextual wrapper exported from `shutdown.ts`.
- **Nitro does not `await` server plugins.** The `0.` filename prefix therefore does *not*
  guarantee close-hook ordering on its own: the first `await` yields, and later plugins register
  their hooks first. `installShutdown` must be called synchronously, before any `await`, or a DB
  pool tears down under a running job.
- **The clean shutdown path calls `close(true)`, not `close(false)`.** BullMQ's `Worker.close()`
  de-dupes concurrent calls, so a later `close(true)` returns the in-flight promise and
  discards the force. Forcing is safe because `drain()` has already established zero in-flight.
  There is a comment in `shutdown.ts` warning against reverting this.
- **Nitro freezes `process.env.NODE_ENV` into the bundle at build time.** `isDev`,
  `isProduction` and the resolved nitro preset are baked into `runtimeConfig` instead. Do not
  reintroduce a runtime `process.env.NODE_ENV` read. The preset must be read via the
  `nitro:init` hook — `nuxt.options.nitro.preset` is `undefined` whenever Nitro auto-detects,
  which is exactly the serverless case the guardrail exists to catch.
- **`ConciergeDriver.depth()` means "due now, not scheduled-later."** The two drivers drifted on
  this because the contract was undocumented; it is documented now.
- **`Consumer.pause()` must resolve immediately** and never await active jobs, or the shutdown
  budget starts counting after the work has already finished.
- **Config overrides use Nuxt's built-in `NUXT_CONCIERGE_*` mechanism.** The only bespoke
  variable is `CONCIERGE_ROLE`, which is validated and throws on an invalid value. Bespoke
  `CONCIERGE_DRIVER` / `_SHUTDOWN_TIMEOUT` / `_STALLED_INTERVAL` reads were added and then
  deliberately removed — do not reintroduce them.

## Corrections to earlier claims

Both of these were wrong in the design document and are corrected there now.

- **Drain removes an instance from rotation by connection refusal, not a 503.** Nitro's
  `http-graceful-shutdown` destroys every socket on signal, independent of supervisor state. The
  state flip is retained for the internal state machine and the pre-teardown window only. The
  guarantee is **not end-to-end testable** — every attempt either tautologises or tests Nitro —
  so it has no lifecycle coverage by design, with a comment in the suite saying so.
- **`SIGKILL` recovery is gated by BullMQ's `lockDuration`, not `stalledInterval`.** It takes
  ~30 s regardless of how low `stalledInterval` is set. `lockDuration` is **not currently
  exposed** as config.

## Known gaps, deliberately carried

- **`typecheck` exists but is unwired**, with 12 pre-existing errors reported and unfixed. There
  is no typecheck step in CI, which is why a client-typings leak went unnoticed until late.
- **`lockDuration` is not exposed** (see above).
- **A worker with dead Redis reports itself healthy** *(partially closed)*. `init()` does not
  block on connectivity by design, since ioredis reconnects. Driver connection-health tracking
  was added and the health endpoint returns 503 when the driver is unhealthy — but this was the
  last thing to land and has the least coverage.
- **`ui-handler.ts` has a concurrent-request race**: two simultaneous first requests each build
  their own BullBoard and `Queue` set. Mitigated by caching the init promise; the queues are now
  closed on shutdown. Spec 4 replaces this file wholesale.
- **`pnpm.packageExtensions` pins `@nuxt/kit` 3.10.0 inside `@nuxt/ui-pro@0.6.1`** to unbreak
  the docs workspace. Matched by exact `name@version`, so it silently stops applying if `docs`
  resolves ui-pro higher. The docs site is rewritten in spec 4 anyway.
- **`role-gate`'s `warnedOnce` flag never re-arms**, so a genuinely different later resolution
  failure would be silent.
- **No CommonJS build.** `@nuxt/module-builder` 1.x emits ESM only; `exports`/`main`/`types`
  point at `module.mjs` and `types.d.mts`.

## Facts that cost real time to establish

- `nuxi typecheck` parses the generated plugin as plain JS (see above) — two build failures
  before that was understood.
- BullMQ exports `UnrecoverableError`, which is the correct way to signal a permanent failure
  and skip retries. Verified against the installed package, not assumed.
- `pnpm publish` defaults to `--tag latest` **even for prerelease versions**, hence
  `publishConfig.tag: "next"` as a structural guard rather than a remembered flag.
- **GitHub's squash-merge uses only the PR title**, so a `Release-As:` footer in the PR body
  never reaches the commit message. It turned out not to be needed — a `feat!:` commit produced
  the major bump on its own — but the mechanism is worth knowing.
- release-please under `versioning: prerelease` proposes a new prerelease for *any* commit,
  including `docs:`. The Release PR is a standing proposal that accumulates; merge it when you
  want to publish, not because it exists.
- `vitest` with `isolate: true` gives each test file its own module registry, so
  `vi.mock('#imports')` in one file cannot leak into another. That is the established pattern
  for testing runtime files that call `useRuntimeConfig`.

## Test-suite conventions established

- `pnpm test` is unit-only and requires no Redis, so contributors without it can run the suite.
  `pnpm test:lifecycle` spawns the real built output; CI runs both against a `redis:7` service.
- **Duplicates are counted and bounded, never asserted to be zero.** Delivery is at-least-once,
  so a clean drain may legally re-run a job — but asserting nothing would let a driver that
  re-runs everything pass.
- Readiness comes from polling the health endpoint, never from fixed sleeps.
- Lifecycle scenarios must be observed failing against the broken behaviour before they count.
