# Spec 4 — Dashboard and driver introspection

Spec 1 made workers survive a deploy. Spec 3 made `enqueue` know what a payload looks like.
Neither tells you what your queue is *doing right now*, and the thing currently claiming to —
a bull-board wrapper at `/_concierge` — refuses to run on the driver developers actually use.

The deliverable is a dashboard that works out of the box on the zero-config path: no
`REDIS_URL`, `auto` resolves to `memory`, role defaults to `both`, and the Nuxt DevTools
Concierge tab shows real queues, real workers and real failed jobs with a decoded payload.

This spec also absorbs **spec 2 (driver introspection SPI)**, which was never written past a
one-line summary. That was deliberate: spec 2's only consumer is this dashboard, and designing
the interface first would have meant designing it against a hypothetical caller. It is designed
here, against real screens.

Prerequisite reading: [the phase 1 decisions record](2026-08-13-phase1-decisions.md) and
[the spec 3 decisions record](2026-08-13-spec3-decisions.md). Constraints in both are
build-breaking or silently behaviour-breaking.

## Scope

### In scope

- A `DriverIntrospection` SPI, optional per driver, with a canonical five-state job model
- Bounded terminal-state history in the `memory` driver, which currently retains none
- A dev-only JSON API under `/_concierge/api`
- A standalone Vue + `@nuxt/ui` SPA, prebuilt into `dist/client`, served as Nitro public assets
- A Nuxt DevTools tab pointing an iframe at it
- Retry as the single write action
- A registry panel: scanned jobs, resolved retry policy, schema presence, generated types
- Deletion of `ui-handler.ts`, the three `@bull-board/*` dependencies, and `managementUI`

### Out of scope

Recorded so none of it is later rediscovered as an oversight rather than a decision.

- **Any production-reachable dashboard, and therefore any auth.** See the decision below.
- **Remove, promote, and pause/resume.** Retry is the only write action.
- **Cron and dedup views** — spec 5 owns those concepts; there is nothing to display yet.
- **The docs site rewrite.** See the correction below.
- Flows, chains, batches
- Editing a payload before retrying it
- SSE or WebSocket live updates; the SPA polls
- Client-side component tests (see Testing for why this is a position, not a gap)

### Corrections to earlier claims

- **The phase 1 record's "the docs site is rewritten in spec 4 anyway"**
  ([phase1-decisions.md:70](2026-08-13-phase1-decisions.md)) is withdrawn. It was used to
  justify leaving the `pnpm.packageExtensions` pin of `@nuxt/kit` 3.10.0 inside
  `@nuxt/ui-pro@0.6.1` in place. Two deliverables sharing a dependency are not one deliverable.
  The pin stays, and stays fragile — it is matched by exact `name@version` and silently stops
  applying if `docs` resolves ui-pro higher. Tracked separately.

- **"Generated payload types per job" cannot be rendered from runtime data.**
  `RegistryEntry.input` holds a `StandardSchemaV1` *object*
  ([supervisor.ts:27-32](../src/runtime/server/supervisor.ts)); the TypeScript payload type is
  erased at build. What is available is the schema's presence and its `~standard.vendor`, plus
  the generated `concierge-jobs.d.ts` read from the build directory as text. The registry panel
  shows those. It does not compute a per-job type.

- **This spec adds a runtime dependency rather than none.** `addCustomTab` comes from
  `@nuxt/devtools-kit`, which runs inside module `setup()` and is therefore a `dependencies`
  entry. The net change is −3 (`@bull-board/{api,h3,ui}`) +1. The alternative — calling
  `nuxt.hook('devtools:customTabs', …)` directly with a hand-declared payload type — is
  rejected: a hand-rolled type against a moving DevTools interface breaks silently, which is
  the failure class both prior retros were dominated by.

## Decisions

**The dashboard is dev-only.** Registration is gated on `nuxt.options.dev`, not on a runtime
flag, so nothing dashboard-related exists in a production bundle. `managementUI` is deleted
rather than carried as a half-secured boolean a user can flip on in production — today it
defaults to `NODE_ENV === 'development'` ([options.ts:118](../src/options.ts)) but is a plain
option, and `/_concierge` sits behind nothing but the `worker`-role gate. A queue dashboard with
a retry button and no authentication should not be one config key away.

The accepted cost, stated so nobody treats it as an oversight: **anyone running concierge in
production gets no queue visibility from this module** and falls back to `redis-cli` or a
separate bull-board install. If that turns out to be a reason people do not choose this module,
a production dashboard with a real authorization design is its own spec, not an amendment to
this one.

**Retry is the only write action.** It closes the actual dev loop — job fails, read the stack,
fix the code, re-run *that payload* rather than reconstructing how it was enqueued. Remove,
promote and pause do not: restarting the dev process is faster than any of them. Pause in
particular is a stateful driver concept BullMQ implements with a Redis key and `memory` would
have to fake, which is a large SPI surface for a button nobody presses against a dev queue.

**Presence is the capability.** `ConciergeDriver.introspect` is an optional cohesive sub-object.
A driver either has introspection or does not, as a type-level fact. The rejected alternative —
boolean flags on `DriverCapabilities` alongside optional methods — permits a driver declaring
`history: true` with no method, or the reverse, and typechecks fine. This is the same move spec 3
made when `validateOnEnqueue` was given a `void` return: make the inconsistent state
unrepresentable rather than merely untested.

The rejected alternative in the other direction — one uniform required interface with `sync`
returning empty arrays — is worse than either. It makes "unsupported" and "genuinely empty"
indistinguishable, so the UI renders a confident empty table that is a lie.

**The SPA is prebuilt at publish time.** Because the output is static assets, `@nuxt/ui`,
`tailwindcss`, `vue` and `vite` are all devDependencies and never enter a consumer's graph.
The rejected alternatives: building inside the consumer's app puts Tailwind in every user's
dependency graph and adds seconds to every dev boot for a panel most boots never open; a
separately published `nuxt-concierge-dashboard` keeps the tarball lean but buys two release
trains and a version-skew failure mode between SPI and UI, which only pays off once the UI
iterates faster than the module.

**The SPA holds no business logic.** Every derived state — a driver cannot do history, a
worker's heartbeat is stale relative to `heartbeatTtl`, these results may have been evicted — is
computed server-side and sent as an explicit flag. The client renders flags. This is the sole
reason shipping no client-side tests is defensible.

**Live updates by polling.** SSE needs a long-lived connection per open panel and Nitro's
WebSocket support is behind an experimental flag. Neither is worth it for a dev panel that can
also just be refreshed.

**No `vue-router` in the SPA.** Panels are top-level state, the iframe has no address bar to
deep-link into, and `ui({ router: false })` is a documented Nuxt UI configuration. This also
removes the need for an SPA history fallback on the static route, which is the harder half of
serving it.

## Architecture

### Process shape and route table

| Path | Registered | Purpose |
| ---- | ---------- | ------- |
| `/_concierge/health` | always | Production readiness probe. **Unchanged by this spec.** |
| `/_concierge/api/**` | `nuxt.options.dev` only | Introspection JSON API |
| `/_concierge/ui/**` (static) | `nuxt.options.dev` only | The prebuilt SPA, via `nitro.options.publicAssets` |

`ui-handler.ts` is deleted, taking with it the concurrent-first-request race that two phase 1
tasks worked around ([phase1-decisions.md:65](2026-08-13-phase1-decisions.md)) and the three
`build.transpile` pushes at [module.ts:88-90](../src/module.ts).

The `role-gate` middleware is **untouched**. It already permits exactly `/_concierge/health` and
nothing else under `role: worker`, with an exact match rather than a prefix match
([role-gate.ts:9-23](../src/runtime/server/middleware/role-gate.ts)). Dev defaults to
`role: both` ([role.ts:40](../src/runtime/server/role.ts)), so in dev the process serving the
dashboard is also the process running the workers — which is what makes the `memory` driver's
in-process state visible at all.

Static assets are served by pushing to `nitro.options.publicAssets` rather than by a bespoke
handler, which yields correct MIME types and caching for free.

**Settled by experiment, in the implementation task (not assumed):** registering the SPA's static
assets at the bare `/_concierge` baseURL was tried first, against a real running Nitro dev server,
not just read about. The result was negative — Nitro's public-asset middleware does **not** fall
through to sibling server routes registered under the same prefix; it shadows them. With
`publicAssets` at `/_concierge`, `GET /_concierge/health` returned `404` even though
`addServerHandler({ route: '/_concierge/health', ... })` was still registered — the exact
"silent mis-resolution presents as an empty panel, not an error" failure mode this note warned
about, except it hit the readiness probe instead of the panel. The same shadowing would have
swallowed all five `/_concierge/api/**` routes the following three tasks add.

The fallback named above was therefore taken: the SPA's static assets are registered at
`/_concierge/ui` instead, one path segment deeper than the API and the health route. Verified
against the same running dev server: `GET /_concierge/ui/` serves the SPA shell (200,
`<div id="app">`, relative `./assets/...` tags resolving correctly one directory deeper — the
reason `base: './'` was made load-bearing in the client build task), and `GET /_concierge/health`
returns its JSON payload again (200), with nothing between them to shadow either one.

**No longer an open question, and no longer resting on a one-off manual check:** the dev-server
lifecycle scenario (`test/lifecycle/dashboard.test.ts`) turns the manual experiment above into
automated, repeatable end-to-end coverage against a real `nuxi dev playground` process, run on
every `pnpm test:lifecycle`. It asserts, over real HTTP, all three routes this fallback touches:
`GET /_concierge/ui/` returns `200` with `<div id="app">` in the body (the SPA shell resolves);
`GET /_concierge/api/overview` returns `200` with a JSON body (`{ driver, introspectable }`), not
HTML — the specific, discriminating signal that the public-asset middleware has *not* swallowed a
sibling API route; and `GET /_concierge/health` still returns `200` in dev, which is the exact
regression the `/_concierge/ui` move fixed and which previously had only unit-level coverage
(module registration, mocking `addServerHandler`, never booting a real Nitro server). The same
scenario also drives a job to `failed` and back through a retry over this same running server,
which is only possible at all because none of the three routes above shadow one another.

### The five states the UI must render deliberately

An empty table is a lie in four of these five, so each gets a defined presentation. This is the
generalisation of the phase 1 note that a `managementUI: false` iframe would 404
([lifecycle-design.md:109-111](2026-08-12-concierge-v2-lifecycle-design.md)).

1. **No supervisor yet.** `getSupervisor()` returns `undefined` for the entire pre-boot window
   by design — `createSupervisor` awaits real network I/O and the generated plugin deliberately
   does not block the HTTP listener. Renders as "starting", never as zero jobs.
2. **`sync` driver.** No queue exists at all. Renders the registry panel plus an explanation of
   why there is nothing else. `sync` implements no introspection.
3. **Driver declares no `introspect`.** Same treatment, generic message.
4. **`isHealthy()` returns false.** Redis unreachable. A banner; last-known counts must not be
   presented as current.
5. **`capabilities.history === 'bounded'`.** The `memory` driver. Completed and failed lists are
   labelled recent-only, evicted oldest-first, and explicitly not durable.

### The introspection SPI

Added to `src/runtime/server/drivers/types.ts` alongside the existing execution interface.

```ts
export type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'

export interface QueueCounts {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

export interface JobSummary {
  id: string
  name: string
  queue: string
  state: JobState
  /** Attempts already made. Never translated to or from "retries". */
  attemptsMade: number
  /** TOTAL attempts including the first, when the driver knows it. */
  attempts?: number
  createdAt: number
  finishedAt?: number
  failedReason?: string
}

export interface JobDetail extends JobSummary {
  /**
   * The RAW stored envelope. Decoding happens in the API layer, never in a
   * driver — see "Payload decoding" below.
   */
  envelope: unknown
  stack?: string
  /** Driver-specific extras. Display-only; nothing branches on this. */
  raw?: Record<string, unknown>
}

export interface DriverIntrospection {
  counts: (queue: string) => Promise<QueueCounts>
  list: (
    queue: string,
    state: JobState,
    page: { offset: number, limit: number },
  ) => Promise<{ items: JobSummary[], total: number }>
  get: (queue: string, id: string) => Promise<JobDetail | undefined>
  retry: (queue: string, id: string) => Promise<void>
}
```

`ConciergeDriver` gains `readonly introspect?: DriverIntrospection`.

`DriverCapabilities` gains exactly one member:

```ts
/** Whether terminal-state results survive, and for how long. */
history: 'durable' | 'bounded' | 'none'
```

It earns its place because eviction is information the UI must show and no method's existence
expresses it. Nothing else is added: every other capability question this dashboard asks is
answered by whether `introspect` is present.

**`JobState` is deliberately five members.** BullMQ also has `paused`, `prioritized` and
`waiting-children`. Including them would mean `memory` fabricating three states to satisfy a
union shaped by one driver's internals, which is exactly how `depth()` drifted in phase 1 before
its contract was written down ([phase1-decisions.md:34](2026-08-13-phase1-decisions.md)).
Driver-specific state goes in `JobDetail.raw`, which the detail view may display and no code
branches on.

`attemptsMade` follows the established rule: **`attempts` is TOTAL attempts including the
first**, and no code anywhere translates between attempts and retries.

### Payload decoding

Drivers return the raw envelope. The API layer decodes it with the existing `decodePayload`
and returns a discriminated result:

```ts
type PayloadResult
  = { ok: true, value: unknown }
  | { ok: false, error: string }
```

Decoding must not move into the drivers. `decodePayload` already owns the `v`-version check and
a shape-describing error that deliberately reports `typeof` rather than content, because a
payload routinely carries user data and the message reaches both the queue backend and the log
stream ([envelope.ts:40-63](../src/runtime/server/envelope.ts)). Three driver implementations of
that path is three chances to drift, and the drift would be a privacy leak rather than a wrong
number.

The consequence to accept: a job whose payload cannot be decoded renders a visible decode error
in the detail view. It must not render blank, and it must not fall back to displaying the raw
envelope string — that would reintroduce the leak the error message avoids.

### Per-driver implementation

**`bullmq`** — full implementation over `getJobCounts`, `getJobs` and `job.retry()`.
`capabilities.history: 'durable'`.

**`memory`** — needs terminal-state history, which it does not currently have.
[memory.ts:53](../src/runtime/server/drivers/memory.ts) retains only `pending`, plus a per-consume
`active` map at line 97; a failed job is logged at lines 140-151 and dropped. Without this,
"show me the failed jobs" is empty on exactly the zero-config path this spec exists to serve.

The addition is a bounded ring buffer per queue holding terminal records, evicted oldest-first,
storing the envelope so `retry` can re-enqueue. Size comes from a new `concierge.memory`
options block mirroring the existing `bullmq` one:

```ts
export interface MemoryOptions {
  /** Terminal-state records retained per queue, evicted oldest-first. */
  historyLimit: number
}
```

Default 100. `capabilities.history: 'bounded'`.

The driver's existing `crossProcess: false` already correctly declares that this is one
process's view — under a split `role` deployment the dashboard would see nothing, which is
accurate rather than broken, and is why the dev default of `role: both` matters.

**`sync`** — no `introspect` property at all. `capabilities.history: 'none'`. It executes
inline and has no queue; the four plausible-looking empty implementations a uniform interface
would require are exactly what "presence is the capability" exists to avoid.

### The HTTP API

All dev-only, all under `/_concierge/api`.

| Endpoint | Returns |
| -------- | ------- |
| `GET /overview` | Supervisor state, role, driver name, `capabilities`, `isHealthy()`, version, queues with concurrency and `QueueCounts`, worker records |
| `GET /queues/:queue/jobs?state=&offset=&limit=` | `{ items: JobSummary[], total }` |
| `GET /queues/:queue/jobs/:id` | `JobDetail` with `envelope` replaced by a decoded `PayloadResult` |
| `POST /queues/:queue/jobs/:id/retry` | 204, or 409 with a reason the UI can display |
| `GET /registry` | See below |

Worker staleness is computed here, not in the client: a record whose `lastHeartbeat` is older
than `worker.heartbeatTtl` is flagged. `WorkerRecord` already carries `lastHeartbeat`, `state`
and its `active` snapshot ([types.ts:24-42](../src/runtime/server/types.ts)).

### The registry panel

Per job: name, source file, queue, whether it declares an `input` schema and that schema's
`~standard.vendor`, and the resolved `attempts`/`backoff` alongside whether each came from the
job definition or from `concierge.defaults`. Plus the generated `concierge-jobs.d.ts` rendered
as text.

Two pieces of plumbing this needs that do not exist yet:

- **Job file paths.** `RegistryEntry` has no `file`. `scanJobs()` has it
  ([scan.ts:24-31](../src/scan.ts)) but passes it only into the generated plugin. The module
  writes a dev-only `jobFiles: Record<string, string>` into `runtimeConfig.concierge`.
- **The generated types path.** Read from `nuxt.options.buildDir` at request time, with the path
  passed through the same dev-only channel.

Both are dev-only additions to `runtimeConfig`, which means they must not be written when
`nuxt.options.dev` is false — the module-registration test asserts that.

This panel is the part bull-board structurally cannot do, and it is where a custom UI earns its
maintenance cost. It is also the right home for the eager-import diagnostic that spec 3 deferred
here ([job-api-design.md:319](2026-08-13-concierge-v2-job-api-design.md)) — noted as the natural
next addition, not built in this spec.

### The SPA

`client/`, a workspace of its own: Vite + Vue 3 + `@nuxt/ui` + Tailwind, using the documented
standalone-Vue setup — `ui()` from `@nuxt/ui/vite` in the Vite config, `ui` from
`@nuxt/ui/vue-plugin` registered on the app, and `@import "tailwindcss"; @import "@nuxt/ui";`
in the CSS entry. `router: false`.

Three panels: Overview (queues and workers), Jobs (queue and state filter, list, detail drawer),
Registry. `/overview` polls on a ~2s interval with a visible pause toggle; the jobs list polls
only while visible.

**Narrow-panel-first layout.** The DevTools frame is a fraction of the viewport
([lifecycle-design.md:107-108](2026-08-12-concierge-v2-lifecycle-design.md)), so job lists
render as a card list below roughly 640px rather than a horizontally-scrolling table. Designing
table-first and retrofitting a breakpoint inverts the effort.

**Dark mode from `prefers-color-scheme` plus a manual toggle persisted to `localStorage`** — not
read from the parent frame. Reaching into `window.parent` to sniff DevTools' theme class would
work today, since both are same-origin in dev, and would be a coupling to someone else's DOM.

The iframe gives complete style isolation: the SPA's Tailwind cannot leak into the host app and
cannot inherit its theme. Both halves of that are accepted.

### Build and ship pipeline

`client/` is added to `pnpm-workspace.yaml`; `vite build` outputs to `../dist/client`, which
`files: ["dist"]` already covers.

| Script | Change |
| ------ | ------ |
| `build:client` | new — `pnpm --filter client build` |
| `dev:client` | new — Vite dev server, proxying `/_concierge/api` to the running playground |
| `prepack` | `pnpm build:client && nuxt-module-build build` |
| `dev:prepare` | gains `pnpm build:client` |

`dev:client` is not optional polish: rebuilding `dist/client` to see a CSS change is unworkable.
Nor is the `dev:prepare` change — without it, a fresh clone's first `pnpm dev` serves a 404 at
the DevTools tab, which reads as a broken module rather than a missing build step.

CI gains the client build plus a bundle-size check. **The ceiling is 820,000 bytes, set from a real
measurement, not invented here.** First measured at 391,841 bytes (`.js` + `.css`) on 2026-08-14
against the placeholder shell alone, with a ceiling of 550,000 (~1.4x). Re-measured at 583,410
bytes on 2026-08-14 once the three real panels (Overview, Jobs, Registry) landed — `UTabs`,
`USelect`, `USlideover` and `UBadge` pull in more of `@nuxt/ui`'s runtime than the shell's bare
`UButton`/`UAlert` did — and the ceiling raised to 820,000 (~1.4x the new measurement), keeping the
same margin rather than the same number. "The queue module added 800 KB to your `node_modules`" is
a fair complaint, and the honest way to bound it is to measure the built output and then fail CI on
regression.

### The DevTools tab

```ts
addCustomTab({
  name: 'concierge',
  title: 'Concierge',
  view: { type: 'iframe', src: '/_concierge/ui/' },
})
```

Registered only under `nuxt.options.dev`, so it costs nothing in production.

**Issue #24 is fixed by deletion.** The banner logs the wrong port because `setup()` runs before
the server listens, so `nuxt.options.devServer.url` is not yet correct at
[module.ts:155-159](../src/module.ts). Rather than move the log into the `listen` hook to compute
a URL nobody needs, the banner becomes a pointer to the DevTools tab. There is then no port left
to get wrong.

## Testing

### The conformance table

One shared file, `test/unit/introspection-conformance.test.ts`, parameterised over every driver
that declares `introspect` — never per-driver files. Spec 3 established this convention for the
retry contract precisely because two independent files are how `depth()` drifted; this contract
now has three implementations rather than two, making it the highest-risk drift surface in the
spec.

The bullmq half is guarded on `REDIS_URL`, which CI already provides. That guard is why the
guard itself matters: without the variable the table silently degrades to memory-only in the one
place it is automated.

`sync` gets a case asserting `introspect` is **absent** — not that calling it fails, which is
a different and weaker claim.

### Unit

- Memory ring-buffer eviction: bounded, oldest-first, **and** that `retry` still succeeds on a
  surviving record after others were evicted. The second half is what catches an eviction that
  corrupts the index rather than merely dropping a row.
- The API layer's `PayloadResult` discrimination, asserting **both** branches. A decode-failure
  test alone passes against an implementation that never succeeds.
- Each of the five UI states against a mocked supervisor, using the established
  `vi.mock('#imports')` pattern under vitest's `isolate: true`.
- Module registration, asserting **both halves**: dashboard routes, public assets, DevTools tab
  and the dev-only `runtimeConfig` additions are present under `dev: true` and **absent** under
  `dev: false`. The negative half is the one that matters — a leak into production is the exact
  failure this spec's registration-time gating exists to prevent, and it is invisible to every
  other test here.

### Lifecycle

One scenario: boot the playground on `memory`, enqueue a job that fails, poll the API until it
appears as `failed`, retry it, and assert it ran again via the existing append-only
`CONCIERGE_TEST_LOG`. That covers the SPI, the API, the ring buffer and retry in a single path.
Readiness comes from polling, never from a fixed sleep.

**It must run against a dev server, not the built output**, and this is a constraint rather than
a preference. The existing harness spawns `playground/.output/server/index.mjs` with
`NODE_ENV: production` ([harness.ts:62-85](../test/lifecycle/harness.ts)), and every dashboard
route in this spec is registered only under `nuxt.options.dev` — so there is no dashboard in that
artifact to test. The harness therefore gains a `spawnDevApp()` that runs `nuxi dev playground`.

The consequence, recorded because it is the reason this scenario is not optional: since the
dashboard exists only in dev, **no production-build test can cover any of it**. Without a
dev-server scenario, nothing in the suite ever loads the real SPA, the real `publicAssets`
registration, or the real API through a real Nitro server — the module-registration unit test
proves the routes are *registered*, never that they *respond*. This is also exactly why the
`publicAssets`/`/_concierge` shadowing regression (see "Process shape and route table" above) was
invisible to that unit test and only surfaced against a real dev server: the unit suite mocks
`addServerHandler` and never boots Nitro, so a route that is registered but unreachable looks
identical to one that works. This scenario's readiness poll against `/_concierge/health` is the
regression test that would have caught it — had this scenario existed before the `publicAssets`
baseURL was fixed, a `/_concierge` (rather than `/_concierge/ui`) registration would have hung the
poll rather than failing it cleanly, since the health route would 404 forever instead of the
harness getting a clear non-200 to report.

This adds a third lifecycle file, which makes **issue #21** materially worse — the suite already
rebuilds the playground once per file and grows linearly. A `globalSetup` is folded into this
spec rather than left to grow.

### Client-side tests

None, deliberately. This is only defensible because of the "SPA holds no business logic"
decision above: if a derived state is ever computed in the client, it must move to the server or
this position collapses. Reviewers should treat client-side logic as a design violation rather
than as untested code.

### The question to ask of every assertion

Both prior retros found that essentially every defect originated in the plan's or the spec's own
reference code rather than in execution, and that the single most repeated defect was
**assertions that could not fail**. Two instances were introduced by fixes for earlier ones.

This spec's highest-risk instance is the conformance table: a table that passes for `memory` and
`bullmq` while asserting nothing a broken state mapping would violate. Bounds must discriminate,
not merely pass.

Ask of every assertion: *would this fail if the behaviour were removed?* And of every test edit:
*does this still cover the case it was written for?*

## Breaking changes

Both are acceptable pre-1.0 and neither needs a migration path.

- **`managementUI` is removed** from `ModuleOptions` and `ResolvedConciergeOptions`. A config
  still setting it gets an unknown-key type error, which is the loud failure.
- **`/_concierge` no longer exists in production builds.** Anyone relying on a production
  bull-board at that path loses it. This is the deliberate trade recorded under Decisions.

### Dependencies

Removed from the root package's `dependencies`: `@bull-board/api`, `@bull-board/h3`,
`@bull-board/ui`.

Added to the root package's `dependencies`: `@nuxt/devtools-kit`. This is the only dependency
this spec adds that reaches a consumer's graph.

Added to **`client/package.json`**, not the root: `@nuxt/ui`, `tailwindcss`, `vue`, `vite`,
`@vitejs/plugin-vue`. `client` is a workspace package that is never published, and the SPA ships
as prebuilt static assets, so none of these enter a consumer's dependency graph at all.

All pinned exactly, per project convention.

## Folded-in issues

- **#21** — lifecycle suite rebuilds the playground per file. Fixed with a `globalSetup`, because
  this spec adds a third file.
- **#24** — dev banner logs the wrong dashboard port. Fixed by deleting the URL.
- **#26** — `test/unit/module.test.ts` is covered by no typecheck script. This spec adds
  substantially to that file.

Deliberately not folded in: **#22** (`attempts: 0` means one attempt), **#23** (transient
lifecycle flake), **#25** (`TypedQueue`'s generic named `Map`). Unrelated to this work.

## Deferred

- A production dashboard, with the authorization design that requires
- Remove, promote, pause/resume
- The eager-import diagnostic on the registry panel
- Cron and dedup views, once spec 5 gives them something to show
- The docs site rewrite, and with it the removal of the `@nuxt/ui-pro` `packageExtensions` pin
