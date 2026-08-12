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

v2 is four specs. This document is #1.

| # | Spec | Summary |
| - | ---- | ------- |
| 1 | **Lifecycle & process model** | Roles, drain, heartbeat registry, minimal driver SPI. **This doc.** |
| 2 | Driver SPI | Execution/introspection split, capability flags, build-time validation |
| 3 | Job API & codegen | `defineJob`, typed `enqueue`, dual-side payload validation |
| 4 | Dashboard | Standalone SPA over the introspection API, DevTools tab |

### In scope for phase 1

- Role resolution (`web` / `worker` / `both`)
- Worker supervisor owning all worker lifecycle
- Graceful shutdown with a drain deadline
- Worker registry with heartbeats
- Three drivers behind a narrow SPI: `sync`, `memory`, `bullmq`
- Boot-time guardrails
- Health endpoint (required by the drain design)
- devalue payload serialization
- The lifecycle test harness

### Explicitly out of scope for phase 1

Typed enqueue and codegen; `defineJob`; the cron redesign; dashboard changes (BullBoard
stays mounted as-is); flows/chains/batches; schema validation; the CLI; the Nuxt 4
toolchain bump (Renovate-driven, tracked separately).

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
| Delivery guarantee | At-least-once | Follows from force-close + stalled recovery; motivates dedup keys in spec 3 |

## Architecture

### Role resolution

Resolved once at boot. Precedence: `CONCIERGE_ROLE` env → `concierge.role` config →
default (`both` in dev, **`web` in prod**).

The resolved value is validated against `web | worker | both` and throws a boot error
otherwise. Without that check a `CONCIERGE_ROLE=workers` typo yields a process that starts no
consumers *and* suppresses the no-worker warning, defeating the exact safeguard the
production default exists to provide.

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

1. **Our own signal listener** does one fast synchronous thing: set `state = 'draining'` so
   the health endpoint returns 503 while the listener is still up. No awaiting.
2. **The `close` hook** performs the drain and owns the timeout budget.

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
4. On the clean path, `close(false)` every consumer.
5. In a `finally`: `deregister(id)`, then `driver.close()`, each bounded by whatever remains
   of the budget. Both run on every path, including when an earlier step threw.
6. Return, letting Nitro tear down everything else.

Drawing steps 2–5 from a single deadline is what prevents a slow `pause()` from consuming the
whole budget and leaving nothing for deregistration.

A second signal forces immediate exit.

`shutdownTimeout` defaults to **25 000 ms**. Railway, Heroku, and k8s
`terminationGracePeriodSeconds` all default to roughly 30 s, so this leaves headroom for the
rest of the close chain.

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
      queues: { default: 10 },         // queue → concurrency
      shutdownTimeout: 25_000,
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
first-class dedup keys in spec 3.

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

**Does Nitro impose its own timeout on `close` hooks?** If it does and it is below 25 s, our
budget must fit inside it — and if it is not configurable, that becomes an argument for
Option B's separate entrypoint much sooner than "later optimization." **This is the first
thing the prototype must establish**, and it may shift the drain design.

**Toolchain staleness.** `pnpm.overrides` pins `nuxi` to 3.10.0 because
`@nuxt/module-builder@0.5.5` cannot drive modern nuxi. Phase 1 implementation requires the
Nuxt 4-compatible bump; Renovate now drives it one testable PR at a time.

**release-please prerelease versioning.** Going `1.0.60` → `2.0.0-alpha.0` may need an
explicit `Release-As: 2.0.0-alpha.0` commit footer. Verify what the first Release PR proposes
before merging it.
