# nuxt-concierge

Queues, workers and background jobs for Nuxt, built on BullMQ.

- [✨ &nbsp;Release Notes](CHANGELOG.md)

## Features

- Define jobs with a single `defineJob` handler, auto-scanned from `server/jobs/`
- Enqueue from anywhere in `server/` with `useQueue`
- Cron scheduling with `defineJob({ cron })`, reconciled at boot with no cross-instance coordination
- Enqueue-side deduplication (`unique`) with lock, throttle and debounce modes
- Workers run as a separate, horizontally-scalable process selected by `CONCIERGE_ROLE`
- Graceful shutdown that drains in-flight jobs before the process exits
- An unauthenticated `/_concierge/health` endpoint for orchestrator readiness/liveness checks
- A `memory` driver for zero-dependency local development, and a `sync` driver for tests
- Guardrails that fail loudly at boot on common misconfiguration, rather than silently later
- A dev-only dashboard in Nuxt DevTools for queue counts, workers, schedules, job history and retry

## Prerequisites

- Nuxt 4
- Node.js >= 22

## Quick Setup

1. Add `nuxt-concierge` dependency to your project

```bash
pnpm add -D nuxt-concierge
```

2. Add `nuxt-concierge` to the `modules` section of `nuxt.config.ts`

```ts
export default defineNuxtConfig({
  modules: ["nuxt-concierge"],
  concierge: {
    connection: { url: process.env.REDIS_URL },
    worker: {
      queues: { default: 5 },
    },
  },
});
```

## Usage

Jobs are defined and enqueued as described in [Defining jobs](#defining-jobs) below. The
job name defaults to the filename (`send-email.ts` → `send-email`; `mail/send.ts` →
`mail/send`). Its queue must be declared in `concierge.worker.queues` — a job targeting an
undeclared queue fails the build rather than silently never running.

Payloads are serialised with [devalue](https://github.com/sveltejs/devalue), so `Date`,
`Map`, `Set` and `undefined` survive the round trip.

### Running workers

Workers run in their own process. Same build artifact, different start command:

```procfile
web:    node .output/server/index.mjs
worker: CONCIERGE_ROLE=worker node .output/server/index.mjs
```

`CONCIERGE_ROLE` is `web`, `worker`, or `both`. It defaults to `both` in dev and
**`web` in production** — processing must be opted into, so forgetting the worker process
means jobs pile up visibly rather than every web instance quietly double-processing.

A `worker` process serves only `/_concierge/health` and returns 503 for everything else.

### Configuration

```ts
concierge: {
  driver: 'auto',                    // 'auto' | 'sync' | 'memory' | 'bullmq'
  connection: { url: process.env.REDIS_URL },
  worker: {
    queues: { default: 5, mail: 2 }, // queue -> concurrency
    shutdownTimeout: 20_000,
  },
}
```

Every option can also be overridden per process, without a rebuild, using Nuxt's built-in
`NUXT_CONCIERGE_*` runtime-config mechanism — e.g. `NUXT_CONCIERGE_DRIVER=bullmq` or
`NUXT_CONCIERGE_WORKER_SHUTDOWN_TIMEOUT=12000`. The one bespoke environment variable is
`CONCIERGE_ROLE`; it is validated at boot and the process exits on an invalid value.

`driver: 'auto'` resolves to `bullmq` when a connection URL is present, and to `memory`
in dev/test when it is absent — so `pnpm dev` needs no Redis. **In production, `auto`
without a connection URL throws at boot** rather than silently falling back to `memory`.

Drivers:

| Driver   | Persistent | Cross-process | Notes |
| -------- | :--------: | :------------: | --- |
| `sync`   | no | no | Runs handlers inline. For tests. |
| `memory` | no | no | Async, in-process, zero dependencies. **Requires `role: 'both'`** — a boot guardrail refuses any other role, because there is no cross-process state for a `web`-only or `worker`-only process to share. Loses every queued job on process exit. |
| `bullmq` | yes | yes | Backed by Redis. The only driver suitable for production. |

#### `concierge.bullmq`

```ts
concierge: {
  bullmq: {
    maxStalledCount: 3,     // BullMQ's own default is 1, which fails a job
                            // permanently after only two force-closes
    stalledInterval: 30_000, // ms before a force-closed job is retried
  },
}
```

#### `concierge.memory`

```ts
concierge: {
  memory: {
    historyLimit: 100, // terminal-state jobs retained per queue, for the dashboard
  },
}
```

`historyLimit` exists solely so the dev dashboard has something to show for the `memory`
driver — it is **not** a durability knob. The `memory` driver keeps no state across a
process restart regardless of this setting; `historyLimit` only bounds how many
completed/failed jobs it keeps *in memory* per queue before evicting the oldest, so a
long-running dev session's job list doesn't grow without bound.

#### `concierge.cron`

```ts
concierge: {
  cron: {
    enabled: true, // master switch for every declared schedule — see "Cron" below
  },
}
```

> **This is a DEPLOYMENT-WIDE switch, not a per-instance one.** `false` does not skip
> reconciliation — it runs the sweep with an *empty* declared set, so every
> concierge-owned schedule is removed from Redis. An instance with it `false` will prune
> the schedules of an instance with it `true`, because neither knows about the other.
> Setting it inconsistently across a fleet makes schedules flap. Also overridable via
> `NUXT_CONCIERGE_CRON_ENABLED=false` — **boot-time only, not live**: reconciliation runs once
> at boot, so this env var takes effect on the next restart of a given instance, not
> immediately on a running one. Which is exactly why this needs to be set the same way
> everywhere.

## Defining jobs

Jobs live in `server/jobs/`. The filename is the job name — `server/jobs/mail/send.ts` is `mail/send`.

> **Import everything explicitly in job files.** The generated job map does `typeof import('<job
> file>')` per job, which pulls every job *module* into the app's TypeScript program — not just
> Nitro's. A job file relying on a Nitro auto-import (e.g. calling `useRuntimeConfig()` with no
> import statement) typechecks fine in the nitro graph but fails in the app graph. Import
> `useRuntimeConfig`, `defineJob`, and anything else your job file uses, the same way the examples
> below do.

### Typed with an interface

```ts
// server/jobs/send-email.ts
import { defineJob } from '#concierge-handlers'
import { mailer } from '../utils/mailer'   // your own module

export interface SendEmailPayload {
  to: string
  subject: string
}

export default defineJob<SendEmailPayload>({
  queue: 'default',
  handler: async (ctx) => {
    await mailer.send(ctx.payload.to, ctx.payload.subject)
  },
})
```

### Typed and validated with a schema

Any [Standard Schema](https://standardschema.dev) validator works — Zod, Valibot, ArkType. Pass `input` and drop the type argument:

```ts
import { z } from 'zod'
import { defineJob } from '#concierge-handlers'
import { mailer } from '../utils/mailer'   // your own module

export default defineJob({
  queue: 'default',
  input: z.object({
    to: z.string().email(),
    subject: z.string().default('(no subject)'),
  }),
  handler: async (ctx) => {
    // ctx.payload.subject is a string — the default has been applied
    await mailer.send(ctx.payload.to, ctx.payload.subject)
  },
})
```

Validation runs on **both** sides. `enqueue` throws immediately if the payload does not match, so a bad payload fails at the call site instead of dead-lettering in a worker minutes later. The worker validates again, because the payload may have been queued by an older deploy — and it is the worker's schema that wins.

If your schema transforms (`.transform()`, `.default()`, coercion), the transform is **applied exactly once, in the worker**. `enqueue` therefore takes the schema's *input* type and `ctx.payload` is its *output* type:

```ts
input: z.object({ id: z.string().transform(Number) })

await enqueue('archive', { id: '42' })   // string
// handler: ctx.payload.id                  number
```

**Your validators must be pure.** *Applied* once is not the same as *called* once: both sides
call the schema, and the producer throws its result away. A pure validator does not care, which
is what Zod, Valibot and ArkType give you — but a `superRefine` that writes to a database or
calls an external service will do so twice, once per side. For the same reason a validator must
not mutate its input in place: `enqueue` serialises the very object it just handed to the
schema.

### Enqueueing

```ts
import { useQueue } from '#concierge'

const { enqueue } = useQueue()

await enqueue('send-email', { to: 'a@b.c', subject: 'hi' })
await enqueue('send-email', { to: 'a@b.c', subject: 'hi' }, { delay: 5_000 })
```

In context, inside an API route that enqueues a job and returns a value — the exact shape that
previously failed `nuxi typecheck` with `Cannot find module '#concierge'` (see the
[CHANGELOG](CHANGELOG.md)):

```ts
// server/api/send.post.ts
import { defineEventHandler, readBody } from 'h3'
import { useQueue } from '#concierge'

export default defineEventHandler(async (event) => {
  const { to, subject } = await readBody(event)
  const { id } = await useQueue().enqueue('send-email', { to, subject })
  return { queued: id }
})
```

Job names autocomplete and payloads are checked at compile time. A typo'd name or a wrong payload shape is a type error, not a runtime surprise.

> **Untyped jobs are not checked.** A job whose default export is not a `JobDefinition` — or
> one that declares neither a type argument nor an `input` schema (neither of the two shapes
> above) — resolves to `unknown` in the generated job map, so `enqueue` accepts any payload for
> that job name with no diagnostic. This is an accepted gap, not a bug: it only affects jobs
> that opt out of both typing mechanisms, and every other job in the map stays fully checked.
>
> A project with no jobs yet has an empty job map, so `enqueue` has no valid name to accept and any call is a type error. Add a file under `server/jobs/` and re-run `nuxi prepare`.

### Retries

```ts
export default defineJob<Payload>({
  attempts: 5,                                        // TOTAL attempts, including the first
  backoff: { type: 'exponential', delay: 1000 },      // 1s, 2s, 4s, 8s
  handler: async (ctx) => { /* ... */ },
})
```

Defaults for every job, set once:

```ts
// nuxt.config.ts
concierge: {
  defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
}
```

A payload that fails schema validation is **never** retried — it would fail identically every time — so it dead-letters immediately without consuming the remaining retry budget.
(The execution it fails in still counts as an attempt — validation runs inside the handler
wrapper, so attempt 1 is spent; attempts 2 and 3 are what get skipped.)

`attempts` must be at least `1`. Nothing validates this: `attempts: 0` is not nullish, so it passes through unvalidated and both drivers run the job exactly once — `0` silently means "once", not "never".

> **Handlers must be idempotent.** Delivery is at-least-once and the default is now three attempts, so a handler that charges a card or sends an email can run more than once for the same job. Make the side effect safe to repeat, or guard it with your own idempotency key.

### Cron

```ts
export default defineJob({
  cron: '*/5 * * * *',               // string shorthand — every 5 minutes, UTC
  handler: async (ctx) => { /* ... */ },
})

export default defineJob({
  cron: {
    expression: '0 9 * * *',
    tz: 'America/New_York',          // the object form for a timezone or a static payload
    payload: { report: 'daily' },
  },
  handler: async (ctx) => {
    ctx.cron?.tick                   // the SCHEDULED fire time — see below
  },
})
```

**The default timezone is UTC, not system-local**, and that default is deliberate: a laptop
and a container disagree about local time, and that disagreement is exactly how "the nightly
job ran at the wrong hour" bugs happen — only ever in production, never in dev. Pass
`tz` explicitly (any IANA zone) when you actually want local wall-clock time.

**Seconds-granularity expressions work.** `'*/2 * * * * *'` (a 6-field pattern) validates and
schedules correctly — `resolveCron` validates by handing the expression straight to
`cron-parser`'s `parseExpression` with no field-count check, so a 6-field pattern passes
through to BullMQ unmodified. Nobody set out to support this; it falls out of the parser
having no opinion on field count. Documented here as a supported shape, not an accident to
avoid relying on.

**`ctx.cron.tick` is the SCHEDULED fire time, not the time the handler started running** —
they differ by queue latency, and only the scheduled time is stable across a retry of the
same tick. Use it as your handler's idempotency key: a handler that used `Date.now()`
instead would get a different value on every attempt, which defeats the entire point of an
idempotency key.

**Reconciliation runs at boot, per instance, with no coordination between instances.** Every
worker process that starts upserts every schedule it declares and removes every
concierge-owned schedule (`concierge:<jobName>` in Redis) that is no longer declared —
adopting concierge on a queue that already carries unrelated BullMQ repeatable jobs leaves
those untouched, since only concierge's own namespaced ids are ever candidates for removal.
No leader election exists because tick-uniqueness is a **driver** guarantee, not the
supervisor's: `bullmq` keeps exactly one delayed job in flight per scheduler, atomically in
Lua, and `memory` is single-process. During a rolling deploy that changes or removes a
`cron` key, old and new code briefly disagree, so **a schedule can miss at most one tick** —
the prune is idempotent and convergent, and a wrong prune self-heals on the very next boot.

**A missed window produces at most one catch-up run, never a backfill.** If a schedule is
unable to fire during an outage (Redis down, no worker running) for what would have been
several ticks, it does not queue one job per missed tick when it recovers — it produces a
single run for whatever the next occurrence is from the moment reconciliation resumes.

### Deduplication

```ts
export default defineJob({
  unique: true,                        // lock — one in-flight job per key at a time
  handler: async (ctx) => { /* ... */ },
})

export default defineJob({
  unique: { ttl: 60_000 },             // throttle — at most one accepted per 60s window
  handler: async (ctx) => { /* ... */ },
})

export default defineJob({
  unique: { ttl: 60_000, debounce: true }, // debounce — coalesces a burst into one run
  handler: async (ctx) => { /* ... */ },   // after the quiet period
})
```

By default the dedup key is `<jobName>:<hash of the serialized envelope>` — a hash of the
exact devalue string the driver is about to store, not an order-insensitive canonical form.
**Object key order affects the default key**, and so do Map/Set insertion order, whether two
equal sub-objects are the same reference or two separately-constructed ones, and whether a
payload bag was built with `Object.create(null)`. Two call sites building the same logical
payload with keys in a different order will **not** deduplicate against each other.

This is a deliberate trade, not an oversight: order sensitivity means deduplication is
occasionally less effective and a job runs twice — which every handler must already
tolerate under at-least-once delivery. The alternative (an order-insensitive canonical form)
was attempted and abandoned across several rounds, because it silently *suppressed* jobs
that should have run — the worse failure by far. If your payload is assembled from more than
one call site and might vary in key order, use `uniqueId` instead:

```ts
export default defineJob({
  unique: { ttl: 60_000 },
  uniqueId: payload => payload.orderId, // your own, stable key derivation
  handler: async (ctx) => { /* ... */ },
})
```

`uniqueId` must be **pure** — an impure key does not fail loudly, it just silently stops
deduplicating.

> **This deduplicates enqueues. It never serializes execution.**
>
> **A cron job's ticks are not deduplicated at all, even when the job declares `unique`.**
> BullMQ's `JobSchedulerTemplateOptions` is `Omit<JobsOptions, … 'deduplication' |
> 'debounce'>`, so a scheduler's template cannot carry deduplication options at the type
> level; `memory` matches that rather than being more forgiving. `unique` applies in full to
> anything you `enqueue` yourself, including a manual run from the dashboard — only
> scheduler-produced ticks are exempt.
>
> To reduce overlap, give the job a dedicated queue with concurrency 1. Note the limit:
> BullMQ's concurrency is per worker *instance*, so two worker processes at concurrency 1
> give you two concurrent runs.

`enqueue`'s result carries a `deduplicated` flag so a caller can tell a suppressed enqueue
from a real one:

```ts
const { id, deduplicated } = await useQueue().enqueue('send-report', payload)
```

For `bullmq`, reading this flag is a best-effort report, not a guarantee: the check and the
add are two separate round trips, so two callers racing on the same key can both observe an
empty key, and the loser reports `deduplicated: false` for an enqueue that was in fact
suppressed. This is one-directional and only affects the *report* — the deduplication itself
stays atomic inside BullMQ's Lua, so no job is ever lost or double-run because of this race.

## Graceful shutdown and delivery guarantees

On `SIGTERM`, concierge stops fetching new jobs, waits up to `worker.shutdownTimeout` for
in-flight work, then force-closes and logs the IDs of anything abandoned.

**An instance is removed from rotation by connection refusal, not by a 503 response.**
Nitro's `http-graceful-shutdown` destroys every open socket — new connections and idle
keep-alive connections alike — as soon as the shutdown signal arrives, independently of
this module's internal state. An operator watching a draining instance will see connection
resets, not a 503 from `/_concierge/health`. (`/_concierge/health` itself stays reachable
under `role: worker` — see below — but that is unrelated to how the instance is drained
from a load balancer's perspective.)

**Delivery is at-least-once.** A job whose process is force-closed mid-handler becomes
*eligible for redelivery* via BullMQ's stalled-job recovery; once `maxStalledCount`
(default 3) is exhausted, it moves to `failed` instead of being retried again.
**Handlers must be idempotent.**

Two distinct post-deploy delays exist, and conflating them is the mistake to avoid:

- A job abandoned at a graceful **force-close** (the `shutdownTimeout` deadline expiring)
  is not retried until `stalledInterval` elapses (default 30s, configurable via
  `concierge.bullmq.stalledInterval`).
- Recovery after an **ungraceful `SIGKILL`** (no drain at all) is gated instead by BullMQ's
  `lockDuration`, which this module does not currently expose. That path takes up to ~30s
  regardless of how low `stalledInterval` is set.

### Nitro's shutdown timeout is applied twice

`NITRO_SHUTDOWN_TIMEOUT` (default 30s) is applied by Nitro in sequence — once while
waiting for HTTP connections to close, and again while waiting for close hooks (which is
where concierge's own drain runs). With the 30s default, the worst case is **60s**, which
exceeds most platforms' deploy grace period. Set `NITRO_SHUTDOWN_TIMEOUT` to roughly half
your platform's grace period (~12s for a 30s grace), and keep `concierge.worker.shutdownTimeout`
below that. The module warns at boot if `shutdownTimeout >= NITRO_SHUTDOWN_TIMEOUT`.

`NITRO_SHUTDOWN_DISABLED` silently disables the drain entirely — close hooks never fire,
so every deploy drops whatever is in flight. The module warns at boot if it is set.

If you run `role: both` alongside SSE or long-polling endpoints, prefer a dedicated worker
process: Nitro waits for those connections to close before the job drain begins.

## Health endpoint

`GET /_concierge/health` is **unauthenticated** and returns the supervisor's state, role,
configured queue names, active job count, and module version. It returns `200` only while
`running`, and `503` otherwise (including before the supervisor has finished starting).

It stays reachable under `role: worker` even though every other route on that process is
refused — orchestrators depend on it for liveness/readiness. Decide for yourself whether
that warrants firewalling it at the network level; the module does not do this for you.

## Dashboard

**Dev-only. There is no production dashboard, and no configuration option that adds one.**
The dashboard's API routes and static assets are registered only when `nuxt.options.dev` is
`true`, decided once at module setup — not by a runtime flag, an environment variable, or
anything else a deployed process could be made to flip. This is deliberate: a queue
dashboard with a retry button needs no authentication of its own specifically *because* it
cannot be reached outside a local dev server.

Open it from **Nuxt DevTools** — look for the "Concierge" tab — or visit `/_concierge/ui/`
directly from your dev server's own base URL (e.g. `http://localhost:3000/_concierge/ui/`);
both reach the same SPA. The module deliberately logs no URL for it, though: the dev
server's own port is not yet known at the point the module logs its startup line, so
printing one was previously wrong whenever port 3000 was taken.

It shows, per queue: live counts by state (waiting/active/completed/failed/delayed), the
worker processes currently attached (with a staleness flag once a heartbeat falls behind
`heartbeatTtl`), a job list per state with decoded payloads, the job registry (every
discovered job, its queue, its schema vendor if any, and its effective attempts/backoff,
plus the generated job-map `.d.ts`), and a Schedules panel listing every declared cron job
with its expression, timezone, next fire time and tick count so far.

The job list shows only the first page (25 jobs) per state — the SPA has no pagination
control yet. The `/_concierge/api/queues/:queue/jobs` endpoint itself already accepts
`offset`/`limit` query parameters (up to 100 per page); a paging control in the dashboard
is a follow-up, not something this endpoint is missing.

**Retry and "Run now" are the only write actions the dashboard performs.** Everything else
is read-only introspection. Retry re-queues a single failed job by ID; it does not delete,
requeue in bulk, or edit a job's payload. "Run now", on the Schedules panel, enqueues one
off-schedule run of a cron job through the exact same `useQueue().enqueue` path a real
production caller would use — including its `unique` policy, so a job with `unique` set can
report a deduplication notice instead of a fresh id if an identical run is already
in flight. It delivers the job's static cron payload but **leaves `ctx.cron` undefined**,
deliberately — `EnqueueOptions.cron` is honoured by the `memory` scheduler only (see its doc
comment in `drivers/types.ts`), so a run-now cannot fabricate a real tick without diverging
by driver. An undefined `ctx.cron` is also the more honest signal here anyway: it distinguishes
"a human pressed a button" from "the schedule fired", which is why every handler should treat
`ctx.cron` as optional (`ctx.cron?.tick`) rather than assuming it is always set.

Introspection is a capability of the active driver, not a fixed feature:

- `bullmq` — full introspection, backed by Redis. Counts, worker list, job list/detail, and
  retry all work.
- `memory` — full introspection, backed by an in-process ring buffer. History is **bounded**
  by `concierge.memory.historyLimit` (default 100 terminal-state jobs per queue, evicted
  oldest-first) and **not durable** — a process restart loses it, same as every other piece
  of `memory` driver state. The dashboard labels this explicitly rather than presenting it
  as equivalent to `bullmq`'s history.
- `sync` — no introspection. `sync` runs handlers inline and keeps no queue state at all;
  the dashboard's panels show "this driver does not support introspection" rather than an
  empty table, which is a different claim than "there are no jobs."

## Migrating from v1

v2 is a breaking rewrite of the public API and the process model.

- `defineQueue`, `defineWorker`, `defineCron` and `$useConcierge` are gone. The public
  API is now exactly `defineJob` (from `#concierge-handlers`) and `useQueue` (from
  `#concierge`).
- The `redis` config option becomes `connection` (e.g. `connection: { url }`).
- Queues are no longer declared with `defineQueue`. They are declared by
  `concierge.worker.queues`, a `Record<string, number>` that doubles as both the queue
  list and the per-queue concurrency setting. A job whose `queue` is not a key in this map
  fails at boot.
- Workers are no longer Nuxt plugins that start automatically. A worker is now a separate
  process running the same build artifact with `CONCIERGE_ROLE=worker`.
- **Cron is back, as `defineJob({ cron })`, and works differently than v1's did.** v1 ran
  every cron job on the first job's own schedule and wiped the shared cron queue on every
  boot. v2 reconciles per-instance at boot with no shared queue and no coordination between
  instances — see [Cron](#cron) — and adds enqueue-side deduplication (`unique`) alongside
  it, see [Deduplication](#deduplication).
- The package no longer ships a CommonJS build. `@nuxt/module-builder` 1.x emits ESM only,
  so `exports`, `main` and `types` in `package.json` point at `module.mjs` and
  `types.d.mts`.

## FAQ

1. **Does this work in a serverless environment?**

   Mostly no. Serverless platforms typically kill the process shortly after the response
   is sent, so a `worker`/`both` role cannot reliably process jobs in the background there.
   `driver: 'auto'` reflects this: it resolves to `memory` in dev/test without a connection
   URL, but **throws at boot in production** without one, rather than silently running an
   in-process, single-instance queue on a platform that recycles instances constantly. If
   you need this module on a serverless web tier, point `connection` at a real Redis
   instance and run the worker role elsewhere.

2. **Can I enable the dashboard in production?**

   No, and there is no configuration option for it. The dashboard is registered only when
   `nuxt.options.dev` is `true`, decided once at build time — not by a runtime flag, an
   environment variable, or anything else a deployed process could be made to flip. See
   [Dashboard](#dashboard).

3. **Can I password protect the dashboard?**

   There is nothing to protect: the dashboard does not exist in a production build. In dev,
   auth would be redundant with the fact that it is not reachable outside your own machine's
   dev server.

## Development

```bash
# Install dependencies
pnpm install

# Generate type stubs
pnpm dev:prepare

# Develop with the playground
pnpm dev

# Build the playground
pnpm dev:build

# Run ESLint
pnpm lint

# Run Vitest
pnpm test
pnpm test:watch

# Run the lifecycle harness (5 scenarios without Redis, 9 with)
pnpm test:lifecycle
REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle
```

## Releasing

Releases are automated — there is no local release command.

[release-please](https://github.com/googleapis/release-please) reads
[Conventional Commits](https://www.conventionalcommits.org/) on `master` and keeps a Release
PR up to date with the next version and changelog. Merging that PR tags the release, which
triggers a publish to npm from CI using trusted publishing (OIDC) with provenance.

Prereleases publish under the `next` dist-tag, so `latest` continues to serve v1.

> **Note on prerelease versions:** a `feat!:` or `BREAKING CHANGE:` commit gives the major
> bump on its own — the v2 line was cut as `2.0.0-alpha` straight from the `1.0.60` seed with
> no manual intervention. A plain `feat:` would only have produced a minor prerelease, so if
> you ever need to force a specific version, add a `Release-As: <version>` footer to a commit
> on `master`. Note that GitHub's squash-merge uses only the PR **title**, so a footer placed
> in the PR body will not reach the commit message. Check the version in the Release PR before
> merging it either way.

Every commit and pull request also publishes an installable preview build via
[pkg.pr.new](https://pkg.pr.new):

```bash
pnpm add https://pkg.pr.new/nuxt-concierge@<pr-number-or-sha>
```
