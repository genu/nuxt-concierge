# nuxt-concierge v2 — Phase 1: Lifecycle & Process Model

**Status:** approved, ready for implementation planning
**Date:** 2026-08-12

## Context

v2 repositions nuxt-concierge from "a BullMQ wrapper for Nuxt" to the ActiveJob-equivalent
layer for Nuxt: the app-native surface over a battle-tested engine. The engine stays
BullMQ. We do not reimplement claim/lease/visibility-timeout/stalled-recovery — those are
Lua scripts running server-side in Redis, and an elegant reimplementation on top of a KV
abstraction loses jobs on the first crash.

Today workers run *inside* the Nitro web server process, started from a generated nitro
plugin. That is the single largest gap versus Sidekiq and Laravel: workers cannot scale
independently of web, long jobs compete with request handling, and shutdown is tied to the
web server's lifecycle.

Phase 1 fixes the process model and the shutdown semantics. Nothing else. Users forgive an
awkward call signature; they do not forgive jobs vanishing on deploy.

## Scope decomposition

v2 was decomposed into four specs. This document is #1. Spec 3 was later narrowed and **spec 5
split out of it**; see [the roadmap](README.md) for current state.

| # | Spec | Summary |
| - | ---- | ------- |
| 1 | **Lifecycle & process model** | Roles, drain, heartbeat registry, minimal driver SPI. **This doc.** |
| 2 | Driver SPI | Execution/introspection split, capability flags, build-time validation |
| 3 | Job API & typed enqueue | `defineJob<Payload>`, typed `enqueue`, dual-side payload validation, per-job retries |
| 4 | Dashboard | Standalone SPA over the introspection API, embedded as a tab in the existing Nuxt DevTools |
| 5 | Cron & dedup | Split out of spec 3 — cron schedules, `unique` / `uniqueId(payload)` |

### Decisions carried forward to spec 3

> **Two of the four recommendations below did not survive spec 3's design and are corrected
> in place: `const Name extends string` is unnecessary, and AST extraction is dropped rather
> than deferred. See [the spec 3 design](2026-08-13-concierge-v2-job-api-design.md).**

From reading `nuxt-cf-jobs@0.16.0`, which has already solved the typed-payload problem for
Cloudflare Queues. Four things to adopt rather than reinvent:

**Infer the payload from the handler signature**, not from a separate type parameter or the
schema:

```ts
type JobPayloadOf<Job> = Job['handle'] extends (payload: infer P, ...args: any[]) => any ? P : never
```

The user writes the payload type once, where the handler already needs it.

~~**Use `const Name extends string`** on `defineJob` so the literal name survives into the type
map. Without the `const` modifier `name` widens to `string` and the whole lookup collapses.~~

**Corrected:** unnecessary here. This is load-bearing in `nuxt-cf-jobs` because the name is a
property of the runtime options object, so the type system is the only thing that can carry the
literal. In concierge `scanJobs()` derives names from file paths at build time, so codegen emits
the map with literal keys and `keyof ConciergeJobMap` is a literal union for free. Adopting the
`const` modifier would also have foreclosed spec 3's chosen API shape, since a `const` type
parameter and an explicit `defineJob<Payload>` type argument cannot coexist — TypeScript has no
partial type-argument inference.

**AST-extract static routing metadata at build time, and lazy-load the handler module.** This
is the important one, and it dissolves a tradeoff recorded earlier in this project's design
discussion. `nuxt-cf-jobs` extracts `name`, `queue`, `maxAttempts`, and flags for
`input`/`uniqueId` directly from the `defineJob({...})` AST, so the producer can route and
validate *without importing the handler*, then `load()` dynamically imports the real module
only when executing. That yields full payload typing **and** a web process that never pulls
handler code (or its dependencies — `sharp`, `puppeteer`, an SMTP client) into its bundle.

The earlier conclusion in this project was that a string-keyed `enqueue(name, payload)` was
necessary to avoid eager handler imports. The problem framing was right; the conclusion was
not. AST extraction plus type-only `typeof import(...)` references gets both properties, so
spec 3 should not concede the ergonomics.

**Corrected: AST extraction is dropped, not deferred — nothing replaces it.** The half of this
that holds is the type-only `typeof import(...)` reference, which is what spec 3 actually uses;
the ergonomics were not conceded. The half that does not hold is AST extraction, because
dual-side validation needs to *execute* a schema and reading source text cannot produce a
runnable object — obtaining one requires importing the module the extraction existed to avoid.
Spec 3 retains eager static imports and treats the lean-bundle problem as a bundling concern,
grouped with the deferred `worker: { entry: 'separate' }` item below rather than solved inside
the job API.

**Steal their build-time validation set:** `duplicate-name` and `invalid-queue` alongside
`invalid-definition`. Duplicate job names in particular are silent and destructive.

Also worth evaluating, in rough order of value: their `unique` / `uniqueId(payload)` pair as
the dedup design; a **transactional outbox**, which enqueues in the same database transaction
as the write that caused it and closes the "job enqueued but the transaction rolled back" hole;
and per-job `middleware` plus a `failed` hook.

### Decisions carried forward to spec 4

Recorded here so they survive until that spec is written.

The DevTools integration is a tab **inside the existing Nuxt DevTools overlay**, alongside
Pages and Components — not a separate window. It is `addCustomTab()` from
`@nuxt/devtools-kit` with `view: { type: 'iframe', src: '/_concierge' }`, registered only
when `nuxt.options.dev`, so it costs nothing in production.

This is nearly free *because* the dashboard is a standalone SPA served from a Nitro route.
Had it been built as Nuxt UI components injected into the host app, there would be no URL to
point an iframe at. Three consequences follow:

- The dashboard must be **responsive down to a narrow panel**. The DevTools frame is a
  fraction of the viewport; a table laid out for 1400px is unusable inside it.
- The tab needs a **defined state when the dashboard is disabled**. With
  `managementUI: false` the iframe would 404, so the tab should hide itself or explain
  rather than render a broken frame.
- The tab can be a **superset, not a mirror**. The scanned job registry, generated payload
  types, and the resolved driver/role are useful in dev and inappropriate in production.

It also completes the zero-config story: first run with no `REDIS_URL` → `auto` resolves to
`memory` → role defaults to `both` → the registry is process-local and therefore visible →
the DevTools tab shows real queues and workers with no infrastructure running.

### In scope for phase 1

- Role resolution (`web` / `worker` / `both`)
- Worker supervisor owning all worker lifecycle
- Graceful shutdown with a drain deadline
- Worker registry with heartbeats
- Three drivers behind a narrow SPI: `sync`, `memory`, `bullmq`
- Boot-time guardrails
- Health endpoint (required by the drain design)
- devalue payload serialization
- A **minimal, untyped `defineJob`** plus `useQueue().enqueue(name, payload)`
- The lifecycle test harness

`defineJob` lands here rather than in spec 3 because phase 1 needs *some* way to declare a
handler — the test harness has to enqueue work and observe it run, and the alpha has to be
dogfoodable in a real app. It ships without codegen or payload typing; spec 3 adds the
generated `name → payload` map and makes `enqueue` generic over it. `defineQueue` and
`defineWorker` are removed: queues are declared by the concurrency map in config, and workers
are infrastructure rather than userland code.

### Explicitly out of scope for phase 1

Typed enqueue and codegen; dashboard changes (BullBoard stays mounted as-is);
flows/chains/batches; schema validation; the CLI; the Nuxt 4 toolchain bump (Renovate-driven,
tracked separately).

**Cron is dropped from the alpha entirely**, not carried forward. The v1 implementation has
two defects — every cron job runs on the *first* job's schedule (a hardcoded index in the
codegen), and `obliterate({ force: true })` on every boot wipes in-flight cron jobs across a
multi-instance deploy — and the codegen layer they live in is being replaced wholesale.
Shipping known-broken cron in an alpha is worse than shipping none. It returns as a property of
`defineJob` rather than a separate concept — **in spec 5, not spec 3**, because its hard part is
schedule reconciliation across a multi-instance deploy rather than the `defineJob` key, and it
would have dominated spec 3.

**No back-compat shims for v1 configuration.** `redis` → `connection` and the new `role` key
are breaking changes, which is the point of a major. A migration guide is written when the API
settles, not incrementally against a moving target.

## Decisions

| Decision | Choice | Rationale |
| -------- | ------ | --------- |
| Worker process | Standalone, separate process | Prerequisite for independent scaling; the defining gap vs Sidekiq |
| Build artifact | **One artifact**, role from env | A second Nitro entry needs per-preset work and would silently not exist on Vercel/Netlify/Cloudflare/Lambda, where the preset owns the entry format. One artifact + a different start command works on every platform on day one. |
| Lean worker bundle | Deferred (Option B) | `worker: { entry: 'separate' }` for node-server/bun later; an optimization, not the foundation |
| Worker binds a port | Accepted | Becomes the health/readiness endpoint and future `/metrics` target — what k8s and Railway want anyway |
| Queue engine | BullMQ, unmodified | Reliability primitives are the hard part and are already solved |
| Postgres driver | Deferred to pg-boss | Same principle: do not hand-roll `SKIP LOCKED` claim logic |
| Serialization | devalue `stringify`/`parse` | Preserves `Date`, `Map`, `Set`, `undefined`; already a Nuxt dependency. **Never `uneval`** — it emits JS source requiring `eval`, which is a deserialization RCE if anything can write to Redis. |
| Delivery guarantee | At-least-once | Follows from force-close + stalled recovery; motivates dedup keys in spec 5 |

## Architecture

### Role resolution

Resolved once at boot. Precedence: `CONCIERGE_ROLE` env → `concierge.role` config →
default (`both` in dev, **`web` in prod**).

The resolved value is validated against `web | worker | both` and throws a boot error
otherwise. Without that check a `CONCIERGE_ROLE=workers` typo yields a process that starts no
consumers *and* suppresses the no-worker warning, defeating the exact safeguard the
production default exists to provide.

**Under `role: worker`, only `/_concierge/health` is served; every other route returns 503.**
The process still binds a port — that is unavoidable with one artifact — but refusing
application traffic makes the process's job unambiguous and prevents a misconfigured load
balancer from routing real requests to a worker.

This is not only hygiene. As the shutdown section below establishes, Nitro drains HTTP
connections *before* calling `close` hooks, so a worker with no long-lived connections reaches
the drain almost immediately. Refusing application routes is what guarantees that.

The production default is deliberate: processing must be opted into. The resulting failure
mode is "jobs pile up and nothing runs" — loud, and caught by the no-worker warning below.
The alternative default would silently have every web instance also process jobs, which
surfaces only as duplicate side effects.

Written to `runtimeConfig.concierge.role` so the health endpoint and (later) the dashboard
can report it.

### Worker supervisor

One object, created by a nitro plugin, and the only thing that touches worker lifecycle:

- starts one driver consumer per configured queue when the role includes `worker`
- maintains an in-flight counter
- owns the state machine: `starting → running → draining → stopped`
- emits heartbeats while `running` or `draining`
- exposes `getState()` for the health endpoint

Under `role: web` the supervisor still exists but starts no consumers. It is not vestigial:
it runs the no-worker warning poll.

### Graceful shutdown

**We cannot own the signal, and do not need to.** Node runs signal listeners in
registration order, and Nitro's node-server entry registers its handler at module load —
before any nitro plugin. Ours can never run first. The mechanism is therefore
`nitroApp.hooks.hook('close')`, which Nitro awaits. The current module already relies on
this (`src/templates.ts`), which is evidence it fires and is awaited.

The design splits accordingly:

1. **Our own signal listener** does one fast synchronous thing: set `state = 'draining'`. No
   awaiting.
2. **The `close` hook** performs the drain and owns the timeout budget.

> **Correction (verified during implementation).** An earlier draft of this document claimed
> the state flip makes "the health endpoint return 503 so load balancers stop routing." That
> is **not** what an operator observes on the node-server preset. Nitro's
> `http-graceful-shutdown` destroys every socket — new and idle keep-alive alike — on signal,
> independently of our supervisor state, so clients see connection resets during drain rather
> than a 503 response.
>
> The flip still earns its place: it drives the internal drain state machine, and it closes
> the narrow window before Nitro tears sockets down. But the operational mechanism that
> removes an instance from rotation is **connection refusal, not a 503**, and the
> documentation must say so.
>
> One consequence for testing: this guarantee is not end-to-end observable, so it has no
> lifecycle-harness coverage by design. Every attempt to assert it either tautologises or
> ends up testing Nitro rather than this module. The state→status mapping is covered by unit
> tests instead.

Drain sequence inside the `close` hook. **The whole sequence is bounded by one deadline
computed at entry, not just the drain step.** `pause()`, consumer close, driver close, and
deregistration can each block or reject; an unbounded shutdown gets `SIGKILL`ed by the
platform, which loses the clean path entirely — the opposite of the goal.

1. `pause()` every consumer. **Contract: `pause()` must not wait for active jobs.** It stops
   fetching and resolves immediately, otherwise the budget below does not start counting
   until in-flight work has already finished. BullMQ's default `worker.pause()` *does* wait,
   so the adapter must call `worker.pause(true)`.
2. `await Promise.race([Promise.all(consumers.map(c => c.drain())), timeout(remaining())])`
3. If that timed out: snapshot `consumer.active()` **before** forcing — `close(true)` can
   clear local active-job tracking — then `close(true)` and log the snapshotted job IDs. IDs
   rather than a count are what make them findable afterwards.
4. On the clean path, `close(true)` every consumer — see the correction below.
5. In a `finally`: `deregister(id)`, then `driver.close()`, each bounded by whatever remains
   of the budget. Both run on every path, including when an earlier step threw.
6. Return, letting Nitro tear down everything else.

> **Correction to step 4 (verified during implementation).** This document originally
> specified `close(false)` on the clean path, with a fallback to `close(true)` if that
> graceful close itself blew the budget. That fallback cannot work: BullMQ's `Worker.close()`
> de-dupes concurrent calls — `if (this.closing) return this.closing` — so once `close(false)`
> is in flight, a later `close(true)` returns the original promise and **silently discards the
> `force` argument**. Shutdown then hangs on the graceful close until Nitro's timeout kills the
> process.
>
> The clean path therefore calls `close(true)`. That is safe because step 2 has already
> established that in-flight work reached zero, so forcing cannot abandon anything, and it
> makes the de-dupe interaction unreachable by construction rather than merely handled. One
> narrow race remains: a job can enter the driver's active map between `drain()` resolving and
> the close being issued, and forcing abandons it — which is honest under at-least-once, and
> strictly better than hanging.
>
> `src/runtime/server/shutdown.ts` carries a comment warning against reverting this. Do not
> "restore" `close(false)` on the basis of this document's original wording.

Drawing steps 2–5 from a single deadline is what prevents a slow `pause()` from consuming the
whole budget and leaving nothing for deregistration.

A second signal forces immediate exit. Note that Nitro's own handler is registered through a
once-factory and therefore ignores repeated signals, so the double-signal escape hatch has to
be ours.

#### How Nitro's shutdown actually behaves (verified, nitropack 2.13.4)

This was the spec's main open risk. Resolved by reading
`nitropack/dist/runtime/internal/shutdown.mjs` and `lib/http-graceful-shutdown.mjs`, wired up
by the `node-server` and `node-cluster` presets.

Nitro's sequence on `SIGTERM`/`SIGINT`:

1. `preShutdown`
2. mark shutting down, close the HTTP server, mark idle keep-alive sockets `connection: close`
3. **poll every 250 ms until all connections are closed, up to `NITRO_SHUTDOWN_TIMEOUT`**
4. *then* `callHook('close')`, raced against **a second, separate `NITRO_SHUTDOWN_TIMEOUT`**
5. `process.exit()` — `forceExit` defaults on

Three consequences, all load-bearing:

**The two timeouts are sequential, not nested.** With the 30 s default, worst-case shutdown is
**60 s**. On any platform with a 30 s grace period the process is `SIGKILL`ed partway through.

**Our drain does not start until HTTP connections have closed.** Step 4 is where our `close`
hook lives, so a lingering connection in step 3 delays the drain — and can starve it
completely. Idle keep-alives are handled, but an in-flight SSE stream, long-poll, or slow
request holds the loop.

**This makes the `role: worker` routing decision load-bearing rather than cosmetic.** A worker
that serves only `/_concierge/health` has no long-lived connections, so step 3 completes in
roughly one poll interval and the drain gets effectively the whole budget. That is what keeps
Option A viable — a worker sharing a process with an SSE endpoint under `role: both` is the
configuration at risk, not the dedicated worker.

**It does not force Option B.** The separate entrypoint stays an optimization.

Derived requirements:

- `shutdownTimeout` defaults to **20 000 ms**, and must be strictly less than
  `NITRO_SHUTDOWN_TIMEOUT` with margin for the `finally` block. When Nitro's race wins, our
  hook is abandoned mid-flight and `process.exit()` follows, so deregistration never runs and
  only the registry TTL cleans up.
- **Warn at boot if `shutdownTimeout >= NITRO_SHUTDOWN_TIMEOUT`** (default 30 000).
- **Warn at boot if `NITRO_SHUTDOWN_DISABLED` is set** — close hooks never fire, so the drain
  silently never runs and every deploy drops in-flight jobs.
- Document `NITRO_SHUTDOWN_TIMEOUT` tuning: because the phases are sequential, it should be set
  to roughly *half* the platform grace period, not all of it. For a 30 s grace, ~12 s is a
  sane value and `shutdownTimeout` should sit below it.

#### Plugin ordering is load-bearing

Close hooks run in registration order. If a DB-pool plugin registers before concierge, its
pool tears down while jobs are still running and in-flight handlers fail on dead
connections mid-drain.

The generated plugin is named `0.concierge-nuxt-plugin.ts`, and that `0.` prefix already
makes concierge register first. Today that is incidental and undocumented. It must become a
stated requirement with an explanatory comment in the generated file, because breaking it
manifests only as mysterious deploy-time job failures.

#### BullMQ defaults we override

- **`maxStalledCount: 3`** (BullMQ default is 1). At 1, a job caught by two force-closes
  fails permanently — too aggressive for long jobs plus frequent deploys.
- **`stalledInterval`** stays 30 s in production but must be **configurable**, because a job
  abandoned at force-close is not retried until it elapses. Users will report this as "jobs
  hang for 30 s after every deploy," so it belongs in the docs beside the at-least-once
  guarantee. Tests set it to 1 s.
- **`lockDuration` is not exposed, and that is a gap** (found while building the lifecycle
  harness). Recovery after a `SIGKILL` is gated by BullMQ's `lockDuration` default, not by
  `stalledInterval`, so an ungracefully-killed worker's jobs take up to ~30 s to become
  eligible for redelivery even with `stalledInterval` lowered. This is real product behaviour
  and the docs must state it. Exposing `lockDuration` alongside `stalledInterval` is the
  obvious follow-up; it was out of scope for phase 1.

### Worker registry

Written by every process that runs workers:

```ts
interface WorkerRecord {
  id: string          // random at boot — hostname+pid can collide after pid reuse
  hostname: string
  pid: number
  role: 'worker' | 'both'
  queues: string[]
  concurrency: Record<string, number>
  version: string     // app version or git sha
  startedAt: number
  lastHeartbeat: number
  state: 'running' | 'draining'
  active: Array<{ jobId: string; queue: string; name: string; startedAt: number }>
}
```

`version` earns its place during rolling deploys: old and new workers are visible
side by side, so a job failing only on old workers is immediately explicable. It resolves
from `CONCIERGE_VERSION` when set — so CI can inject a git SHA — otherwise from the host
app's `package.json` version, otherwise `'unknown'`.

**Storage goes through the driver**, not a separately configured backend. The registry must
be readable from the web process — which runs no workers — so it needs shared storage, and
the driver already holds that connection. Redis: a hash per worker with a TTL. Memory: a
`Map`.

Consequence, stated rather than discovered: the memory driver's registry is process-local,
so a web process cannot see worker records. This is consistent, because memory already
implies `role: both` — the same constraint as the `crossProcess` guardrail, not a new
limitation.

**Cadence: heartbeat every 5 s, record TTL 15 s** (three missed beats). Redis expiry handles
eviction; the memory driver filters on read. Fast enough for a live dashboard and sub-15 s
death detection, while 50 workers cost 10 writes/sec.

**Active jobs are snapshotted by the heartbeat, not written on transition.** Writing per job
start/finish would add two registry writes per job to the hot path. Snapshotting makes the
active-job view up to 5 s stale — irrelevant in practice — and keeps throughput cost flat.

**Deregistration** is explicit on clean shutdown; TTL covers crashes and `SIGKILL`.

### No-worker warning

The `role: web` supervisor polls every 60 s: if a configured queue has depth and no live
worker claims it, log a warning, throttled to once per 10 minutes per queue.

Deliberately *not* on enqueue — that would put a registry read on the hot path.

### Driver SPI (phase 1)

Narrow by design; introspection arrives in spec 2.

```ts
interface ConciergeDriver {
  readonly name: string
  readonly capabilities: { persistent: boolean; crossProcess: boolean }

  init(): Promise<void>
  close(force: boolean): Promise<void>

  enqueue(queue: string, job: EnqueuePayload): Promise<{ id: string }>
  consume(queue: string, opts: ConsumeOptions, handler: JobHandler): Consumer
  depth(queue: string): Promise<number>

  heartbeat(record: WorkerRecord): Promise<void>
  deregister(id: string): Promise<void>
  workers(): Promise<WorkerRecord[]>
}

interface Consumer {
  pause(): Promise<void>          // stop fetching; resolves immediately, never awaits active jobs
  drain(): Promise<void>          // resolves when in-flight hits 0
  close(force: boolean): Promise<void>
  activeCount(): number
  active(): ActiveJob[]
}
```

`pause` and `drain` are separate because the drain sequence needs "stop fetching" as a
distinct step from "wait for in-flight." BullMQ's `close(false)` fuses them, but
`worker.pause(true)` returns without waiting, so the mapping is clean.

**Capabilities are limited to `persistent` and `crossProcess`.** Declaring the full
capability set now would be speculating about checks nothing reads; spec 2 adds what its
build-time validation needs.

### Payload envelope

```ts
job.data = { v: 1, payload: devalue.stringify(userPayload) }
```

The `v` field allows the envelope to change without a migration. Phase 1 has exactly one
version, so a decoder table would be speculative — but the unknown-version path must be
defined now: a payload with an unrecognised `v` fails the job with a distinct, non-retryable
error, rather than crash-looping the worker or silently discarding the job.

A further consequence to accept:
BullBoard renders the payload as an opaque devalue array. Spec 4's dashboard parses it
properly; this is one more reason the custom UI replaces BullBoard rather than wrapping it.

### Drivers

**`sync`** (~40 lines) — `enqueue` awaits the handler inline; `consume` is a no-op; registry
methods return empty. Two documented consequences: handler errors propagate to the *caller*
of `enqueue`, and retries do not apply. Both are the point — it is what makes tests fail
loudly. Default driver in tests.

**`memory`** (~150 lines) — in-process queue with a real claim/lease loop so delays, retries,
and concurrency behave like the other drivers. This is the only driver where we write claim
logic, which is acceptable precisely because crash-correctness is explicitly not a goal for
it.

**`bullmq`** — wraps existing code; `persistent: true`, `crossProcess: true`; applies the
default overrides above.

### Guardrails (boot time)

| Condition | Action |
| --------- | ------ |
| `!capabilities.crossProcess && role !== 'both'` | **throw** |
| `!capabilities.persistent && NODE_ENV === 'production'` | warn loudly |
| role includes worker, zero queues configured | warn |
| serverless nitro preset + `!capabilities.persistent` | warn |

Rule 1 is derived from capability rather than driver name, so it covers `memory` + `worker`
and `sync` + `worker` with one rule and any future driver for free.

Rule 2 warns rather than throws: someone may genuinely want a non-persistent driver for a
toy deploy, and throwing on a production boot is hostile.

### Health endpoint

`GET /_concierge/health` returns `200 { state, role, queues, activeCount, version }` only in
`running`, and `503` in `starting`, `draining`, and `stopped`. Readiness must stay false until
consumers are actually up rather than merely until the HTTP listener binds — otherwise a
rolling deploy routes traffic to a process that cannot yet do work.

Required by the drain design; also serves as the k8s readiness probe and the future `/metrics`
host. Tested across all three roles.

## Configuration

```ts
export default defineNuxtConfig({
  modules: ['nuxt-concierge'],
  concierge: {
    driver: 'auto',                    // 'auto' | 'sync' | 'memory' | 'bullmq'
    connection: { url: process.env.REDIS_URL },
    role: undefined,                   // 'web' | 'worker' | 'both'; CONCIERGE_ROLE wins
    worker: {
      queues: { default: 5 },          // queue → concurrency; also declares the queues
      shutdownTimeout: 20_000,         // must stay below NITRO_SHUTDOWN_TIMEOUT
      heartbeatInterval: 5_000,
      heartbeatTtl: 15_000,
    },
    bullmq: {
      maxStalledCount: 3,
      stalledInterval: 30_000,
    },
  },
})
```

`driver: 'auto'` resolves to `bullmq` when a connection URL is present. Without one it
resolves to `memory` **in development and test only**; in production it throws a targeted
configuration error naming `REDIS_URL` and the explicit `driver` option.

That restriction is load-bearing. Production defaults `role` to `web`, and guardrail rule 1
throws for any non-`crossProcess` driver outside `role: 'both'` — so an unrestricted `auto`
fallback to `memory` would fail production boot with a confusing capability error when the
actual problem is a missing connection URL.

Zero-config first run is the main adoption lever for the driver abstraction; it is not about
production portability, since nobody migrates queue engines mid-project.

`worker.queues` does double duty in phase 1: it is both the concurrency map and the queue
declaration, since `defineQueue` is gone and `defineJob` carries only a queue *name*. A job
naming a queue absent from this map is a boot-time error rather than a silently orphaned job.

Concurrency defaults to **5** per queue, matching Sidekiq. Ten was the earlier draft and is
too aggressive as a default — handlers that touch a database will exhaust a typical connection
pool before the queue saturates.

Deployment shape:

```procfile
web:    node .output/server/index.mjs
worker: CONCIERGE_ROLE=worker node .output/server/index.mjs
```

## Guarantees

**At-least-once.** A job interrupted by force-close becomes *eligible for redelivery* —
BullMQ's stalled recovery re-queues it, but once `maxStalledCount` is exhausted it moves to
`failed` instead. "Will run again" would overstate the guarantee. Handlers must be idempotent
regardless. This is correct semantics rather than a shortcoming, and it is what motivates
first-class dedup keys in spec 5.

The idempotency requirement gets sharper in spec 3, which changes the default from effectively
one attempt to three: a non-idempotent handler that previously failed once and stopped will run
its side effects up to three times.

**The `memory` driver loses everything on process death.** Acceptable for a dev/test driver,
but it must be stated loudly rather than implied.

## Testing

### Harness

`test/lifecycle/` builds the playground once per suite, then per scenario: spawns
`.output/server/index.mjs` with a given `CONCIERGE_ROLE` and driver, waits for a readiness
signal, enqueues N jobs over HTTP, sends a real signal, and asserts against a durable log.

Jobs append `{ jobId, attempt, pid }` per completion to a file the test reads after the
process dies. Assertions:

- every enqueued id appears at least once → nothing lost
- ids appearing more than once are **counted and reported, not asserted to be zero** —
  asserting zero would encode a guarantee we deliberately do not make, and the test would
  flake
- distinct pids prove work actually crossed the restart

### Matrix

| Scenario | `bullmq` | `memory` |
| -------- | -------- | -------- |
| clean drain within budget | all complete once | all complete once |
| SIGTERM mid-flight | all complete ≥1 | all complete ≥1 |
| drain exceeds timeout → force close | all complete ≥1 after stall recovery | documented loss |
| SIGKILL | all complete ≥1 after stall recovery | total loss |
| second signal | immediate exit | immediate exit |
| `crossProcess:false` + `role:worker` | — | boot throws |

### Practical constraints

- **Split the scripts.** `pnpm test` stays unit-only so contributors without Redis can run
  it; `pnpm test:lifecycle` runs the harness. CI runs both, with a `redis:7` service
  container added to `ci.yml`.
- **`stalledInterval` configurable** — otherwise the force-close and SIGKILL rows each take
  30 s+.
- **Prefer explicit readiness signals over fixed sleeps.** These tests are timing-dependent by
  nature, and a flaky lifecycle test is the one kind that must never be quietly skipped —
  skipping it removes the only regression signal for the shutdown guarantee. If a scenario does
  become flaky, quarantine it with a named owner and a tracking issue that still surfaces a
  visible failure. `skip` is not an acceptable resting state here.

Current coverage is one trivial test (`test/basic.test.ts`), so this harness is effectively
the first real suite in the repo and needs vitest configuration that does not yet exist.

### Manual acceptance gate

50 slow jobs in flight on Railway; trigger a redeploy; confirm all 50 appear in the log and
both app versions are visible in the registry during the rollover.

## Risks and open questions

**~~Does Nitro impose its own timeout on `close` hooks?~~ Resolved** — yes, 30 s by default via
`NITRO_SHUTDOWN_TIMEOUT`, applied *twice* in sequence. See "How Nitro's shutdown actually
behaves" above. Option A survives; the derived requirements are folded into the shutdown
section.

**`role: both` with long-lived connections is the remaining lifecycle hazard.** Because Nitro
drains HTTP before calling `close` hooks, an SSE or long-poll endpoint in the same process can
delay or starve the job drain. Dedicated workers are unaffected. Not blocking phase 1, but the
lifecycle harness should eventually include a `role: both` scenario holding an open SSE
connection, and the docs should steer anyone with streaming endpoints toward a separate worker
process.

**Toolchain staleness.** `pnpm.overrides` pins `nuxi` to 3.10.0 because
`@nuxt/module-builder@0.5.5` cannot drive modern nuxi. Phase 1 implementation requires the
Nuxt 4-compatible bump; Renovate now drives it one testable PR at a time.

**release-please prerelease versioning.** Going `1.0.60` → `2.0.0-alpha.0` may need an
explicit `Release-As: 2.0.0-alpha.0` commit footer. Verify what the first Release PR proposes
before merging it.
