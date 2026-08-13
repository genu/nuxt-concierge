# nuxt-concierge

Queues, workers and background jobs for Nuxt, built on BullMQ.

- [✨ &nbsp;Release Notes](/CHANGELOG.md)

## Features

- Define jobs with a single `defineJob` handler, auto-scanned from `server/jobs/`
- Enqueue from anywhere in `server/` with `useQueue`
- Workers run as a separate, horizontally-scalable process selected by `CONCIERGE_ROLE`
- Graceful shutdown that drains in-flight jobs before the process exits
- An unauthenticated `/_concierge/health` endpoint for orchestrator readiness/liveness checks
- A `memory` driver for zero-dependency local development, and a `sync` driver for tests
- Guardrails that fail loudly at boot on common misconfiguration, rather than silently later

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

## Defining jobs

Jobs live in `server/jobs/`. The filename is the job name — `server/jobs/mail/send.ts` is `mail/send`.

### Typed with an interface

```ts
// server/jobs/send-email.ts
import { defineJob } from '#concierge-handlers'

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

If your schema transforms (`.transform()`, `.default()`, coercion), the transform runs **exactly once, in the worker**. `enqueue` therefore takes the schema's *input* type and `ctx.payload` is its *output* type:

```ts
input: z.object({ id: z.string().transform(Number) })

await enqueue('archive', { id: '42' })   // string
// handler: ctx.payload.id                  number
```

### Enqueueing

```ts
import { useQueue } from '#concierge'

const { enqueue } = useQueue()

await enqueue('send-email', { to: 'a@b.c', subject: 'hi' })
await enqueue('send-email', { to: 'a@b.c', subject: 'hi' }, { delay: 5_000 })
```

In context, inside an API route that enqueues a job and returns a value — the exact shape that
previously failed `nuxi typecheck` with `Cannot find module '#concierge'` (see the
[CHANGELOG](/CHANGELOG.md)):

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

A payload that fails schema validation is **never** retried — it would fail identically every time — so it dead-letters immediately without consuming the attempt budget.

> **Handlers must be idempotent.** Delivery is at-least-once and the default is now three attempts, so a handler that charges a card or sends an email can run more than once for the same job. Make the side effect safe to repeat, or guard it with your own idempotency key.

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

### Queue Management UI

The BullBoard dashboard is available at `/_concierge/` whenever `managementUI` is enabled
and the active driver is `bullmq`. It returns 503 (rather than crashing) if the active
driver is anything else, since there is nothing BullBoard can introspect.

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
- **Cron is not in this release.** The v1 implementation ran every cron job on the first
  job's own schedule and wiped the shared cron queue on every boot — it was not carried
  forward. It returns in a future release as a property of `defineJob`.
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

2. **Can I disable the Queue management UI in production?**

   It is already disabled by default in production. To enable it explicitly:

   ```ts
   export default defineNuxtConfig({
     concierge: {
       connection: { url: process.env.REDIS_URL },
       managementUI: true,
     },
   });
   ```

3. **Can I password protect the Queue management UI?**

   Auth for the UI is out of scope of this module, but it can easily be done using the [Nuxt Security](https://nuxt-security.vercel.app/) module.

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
