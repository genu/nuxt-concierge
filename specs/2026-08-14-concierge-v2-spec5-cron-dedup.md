# Spec 5 — Cron and deduplication

Spec 1 made workers survive a deploy. Spec 3 made `enqueue` know what a payload looks like and
changed the effective default from one attempt to three. Spec 4 made the queue visible in dev.
What is still missing is the other half of how background work actually gets started — **on a
schedule, rather than because a request happened** — and the mitigation for the idempotency
burden spec 3 sharpened.

Cron was dropped from the v2 alpha rather than carried forward. The v1 implementation had two
defects: every cron job ran on the *first* job's schedule, because the codegen used a hardcoded
index, and `obliterate({ force: true })` on every boot wiped in-flight cron jobs across a
multi-instance deploy. Both lived in a codegen layer that has since been replaced wholesale.
This spec brings cron back as a property of `defineJob`, with the reconciliation problem treated
as the actual subject rather than an implementation detail of the key.

Deduplication ships alongside it for two reasons. It shares the `defineJob` surface, the driver
SPI extension, and the dashboard work, so splitting means paying the integration cost twice. And
it is the standing answer to the at-least-once caveat both prior specs documented and neither
addressed.

Prerequisite reading: the [phase 1](2026-08-13-phase1-decisions.md),
[spec 3](2026-08-13-spec3-decisions.md) and [spec 4](2026-08-13-spec4-decisions.md) decisions
records. Constraints in all three are build-breaking or silently behaviour-breaking, and the ones
that bear directly on this work are restated in [Inherited constraints](#inherited-constraints)
rather than left to be rediscovered.

## Scope

### In scope

- `cron` as a `defineJob` property, string shorthand or object form with `tz` and a static payload
- Boot-time schedule reconciliation: idempotent upsert plus mark-and-sweep pruning, per queue
- Tick metadata (`ctx.cron`) delivered to the handler
- Boot-time validation of a static cron payload against the job's own `input` schema
- A `DriverScheduling` SPI, optional per driver, following spec 4's presence-is-capability pattern
- Three deduplication modes — lock, throttle, debounce — mapped onto verified BullMQ primitives
- `uniqueId(payload)`, with the default key derived from the serialized envelope
- `enqueue` returning `{ id, deduplicated }`
- Full `memory` driver parity for both features, held to one shared conformance table
- A Schedules panel in the dev dashboard, with run-now
- `concierge.cron.enabled` as a global kill switch

### Out of scope

Recorded so none of it is later rediscovered as an oversight rather than a decision.

- **Serialized execution.** This spec deduplicates *enqueues*. It never guarantees that at most
  one instance of a job is *running*. See the decision below; this single exclusion covers both
  cron overlap and the missing fourth dedup mode.
- **Backfill of missed ticks.** At most one catch-up run, then normal resumption.
- **A global overlap guarantee for cron.** There is a documented recipe with a documented limit.
- **Leader election.** Not needed, and the reasoning is load-bearing — see Decisions.
- **Imperative / runtime-created schedules.** Trigger.dev's `schedules.create({ externalId })`
  shape — one task, many schedules, one per tenant — is a genuinely useful pattern and a
  different feature. Schedules here are declared in source and reconciled from it.
- **A dedup panel in the dashboard.** A deduplicated job does not exist to be listed. See
  Architecture.
- **`every: <ms>` interval schedules.** BullMQ supports them alongside `pattern`; cron expressions
  are the requested feature and a second scheduling syntax doubles the conformance surface for
  `memory`. Deferred, not rejected.
- **`limit`, `startDate`, `endDate` on a schedule.** Same reasoning.
- Production-reachable dashboard, and therefore auth — unchanged from spec 4.

### Corrections to earlier claims

- **The phase 1 design's "their `unique` / `uniqueId(payload)` pair as the dedup design"**
  ([lifecycle-design.md:89-90](2026-08-12-concierge-v2-lifecycle-design.md)) is too small. A
  boolean `unique` collapses three genuinely different guarantees into one name. The survey
  section below sets out the taxonomy; the API here has three modes, not one flag. `uniqueId` as
  a payload-derived key survives intact.

- **"Prefix-scoped" mark-and-sweep, as framed during design discussion, was imprecise and
  overstated the risk.** `getJobSchedulers()` is a method on `Queue`, not on the connection, so a
  sweep is naturally scoped to `(prefix, queueName)` — not to a global prefix namespace. Two
  applications would have to share a Redis *and* a prefix *and* a queue name to interfere, at
  which point they are already sharing a queue and stealing each other's jobs. The sweep is
  therefore **per declared queue**, and no new prefix configuration is required for safety.

- **The Schedules panel cannot show a last-fire time.** `JobSchedulerJson`
  (`bullmq/dist/esm/interfaces/job-scheduler-json.d.ts`, verified in 5.63.0) exposes `key`,
  `name`, `tz`, `pattern`, `every`, `next`, `offset`, `iterationCount`, `limit`, `startDate`,
  `endDate` and `template`. There is no previous-fire field; `RepeatOptions.prevMillis` is marked
  internal and is not returned. The panel shows `next` and `iterationCount`. It does not fabricate
  a last-fire time from the most recent produced job, because that is an extra read per row whose
  only purpose is to make a column look complete.

## What the ecosystem does

Recorded because several decisions below are "the same thing everyone else concluded," and that
is worth more than a fresh argument. **BullMQ facts in this document were verified against the
installed 5.63.0 source; the rest is survey and should be re-checked before it becomes a
guarantee we make to users.**

**Who enqueues the tick** splits three ways. Leader election — Oban's `Oban.Peer`, Sidekiq
Enterprise's periodic jobs, Celery beat's must-run-exactly-one-process model. A uniqueness
constraint on `(schedule, tick_time)` — Solid Queue's unique index on `recurring_executions`,
GoodJob's `cron_key`/`cron_at` — which converts leader election into an idempotency constraint
and needs no lock. Or BullMQ's approach: one delayed job in flight per scheduler, produced
atomically in Lua.

**Removal of a deleted schedule** is mark-and-sweep in the most-deployed Ruby scheduler:
sidekiq-cron's `load_from_hash!` — the bang variant — destroys schedules absent from the supplied
config.

**Missed ticks** show unanimous agreement. Quartz names the policy
`MISFIRE_INSTRUCTION_FIRE_NOW` / `fireAndProceed`; Sidekiq Enterprise and Celery beat skip missed
windows entirely; Oban does not backfill. Nobody replays a storm.

**Timezone** is per-schedule IANA with a UTC default in Trigger.dev, sidekiq-cron and Oban Cron
alike.

**Tick metadata** is Trigger.dev's contribution: its scheduled tasks receive `timestamp`,
`lastTimestamp`, `upcoming`, `scheduleId` and `timezone`. A handler that knows which tick it is
has a natural idempotency key.

**Overlap** is answered in the modern systems by a keyed concurrency limit of 1 (Trigger.dev's
`concurrencyKey`, Inngest's `concurrency.key`), not by a lock.

**Deduplication semantics** are best articulated by sidekiq-unique-jobs, whose four lock types —
`until_executing`, `until_executed`, `while_executing`, `until_expired` — name distinctions that
a boolean cannot. Oban's `unique: [fields:, states:, period:]` makes the same point from another
angle: *which job states count as a duplicate* is a real question with more than one defensible
answer.

## Decisions

**No leader election.** BullMQ already solves double-fire inside the driver — one delayed job in
flight per scheduler, produced atomically in Lua — so a leader would be solving the same problem a
second time, with lock acquisition, TTL renewal and handoff as the price. Every instance that runs
workers reconciles at boot, with no coordination between them; `upsertJobScheduler` is idempotent
by scheduler id, so N instances doing it is indistinguishable from one.

The consequence worth stating in the SPI rather than leaving implicit: **tick-uniqueness is a
driver responsibility, not a supervisor one.** `bullmq` gets it from Lua, `memory` gets it from
being single-process and non-durable. A future driver with neither would double-fire every
schedule, silently, and the SPI doc is the only place that can warn its author.

**Removal is boot-time mark-and-sweep, per queue.** At boot, for each queue this instance
declares: upsert every cron job targeting it, list that queue's schedulers, remove any whose id is
not in the declared set. No coordination and no new lifecycle surface. The prune is idempotent and
convergent — a wrong prune self-heals on the next boot.

The accepted cost, stated so it is not later filed as a bug: **during a rolling deploy that
changes or removes a `cron` key, old and new code disagree for the deploy window, so a schedule
can miss at most one tick.** The rejected alternative was version-gating the prune against the
heartbeat registry, which closes that window but trades a small documented gap for a subtler
failure mode — a stale or partially-written registry would suppress pruning with no signal at all.
A missed tick is visible; a schedule that quietly stops being reconciled is not.

The rejected alternative in the other direction — upsert-only, never prune — is a slower-motion
version of the v1 defect. A deleted job's scheduler keeps producing jobs whose handler no longer
exists, which fail permanently, on a schedule, forever.

**This spec deduplicates enqueues and never serializes execution.** One sentence, because it
carries two exclusions that would otherwise be argued separately. Cron overlap and
sidekiq-unique-jobs' `while_executing` are the same missing primitive: a lock held for the
duration of a job's execution, renewed against its own liveness, released on crash. That is the
leader-election machinery declined above wearing a different hat, and building it is its own spec.

**A cron job's ticks are not deduplicated at all, even when the job declares `unique`.** This
corrects an earlier claim in this document that `cron` plus `unique` would give "no more than one
*queued* at a time" — it will not, on either driver, and the reason is not a choice this spec made.
BullMQ's own `JobSchedulerTemplateOptions` is
`Omit<JobsOptions, 'jobId' | 'repeat' | 'delay' | 'deduplication' | 'debounce'>`
(`bullmq/dist/esm/types/job-scheduler-template-options.d.ts`, verified in 5.63.0): a job scheduler's
template **cannot carry deduplication options**, at the type level. `memory` matches that rather
than being more forgiving, for the same reason it matches everything else — a `memory` driver that
deduplicated ticks while `bullmq` did not would be the retry divergence all over again, with dev
showing a guarantee production does not have.

`unique` still applies in full to anything you `enqueue` yourself, including a manual run of a cron
job from the dashboard. It is only the scheduler-produced ticks that are exempt.

What exists instead is a recipe with an honest boundary. Give the job a dedicated queue with
concurrency 1 — no new machinery, `worker.queues` already does this. **But BullMQ's concurrency is
per `Worker` instance**, so two worker processes at concurrency 1 give you two concurrent runs.
Sidekiq has the same property; BullMQ Pro's groups are the paid global answer. The docs state the
recipe and the limit together, because the recipe alone reads as a guarantee it is not.

**Deduplication has three modes, not one flag.** They are genuinely different guarantees and
BullMQ implements all three natively, so collapsing them costs users correctness and saves us
nothing. See [Deduplication semantics](#deduplication-semantics) for the verified mapping.

**`memory` gets full dedup parity — all three modes.** This is the spec 3 lesson restated, and it
is the most expensive one in the project's history: BullMQ's default `attempts: 0` meant a failing
job was never retried in production while `memory` retried it three times, so *the forgiving
driver was the one developers saw*. A `memory` driver implementing the lock mode and faking
throttle and debounce reproduces that shape exactly — and dedup divergence is worse than retry
divergence, because the symptom is a job that silently never ran.

**`sync` supports neither cron nor dedup.** Not as a gap, as a consequence of what `sync` is for.
It executes inline so errors propagate to the `enqueue` caller; a cron job has no `enqueue` caller,
so scheduling it would mean adding exactly the background timer `sync` exists not to have, and
deduplicating it would mean silently not running, which is precisely what `sync` exists to
prevent. It ignores dedup exactly as it already ignores `attempts`
([drivers/types.ts:36-38](../src/runtime/server/drivers/types.ts)), so `deduplicated` is always
`false`, and boot warns if any job declares `cron` while the driver resolves to `sync`.

**Cron fires in dev, with a global kill switch.** Under `nuxt dev` the driver is typically
`memory` and the role typically `both`, so the dev server *is* a worker. "It silently did not run
in dev" is the same failure class as the v1 defects, and a dev server is short-lived enough that
anything coarser than `*/5` rarely fires at all. `concierge.cron.enabled` turns every schedule off
without editing job files, which earns its place well beyond dev — a staging environment pointed
at production-like data is the real case. It is overridden through Nuxt's standard
`NUXT_CONCIERGE_*` mechanism; no bespoke environment variable, per the phase 1 constraint.

**Tick metadata goes on `ctx`, not `ctx.payload`.** Putting it in the payload would collide with
the job's own `input` schema — a schema that validates the user's payload shape would reject an
object with `tick` grafted on, permanently, on a schedule. On `ctx` the collision is
unrepresentable.

**Timezone defaults to UTC, not system-local.** A laptop and a container disagree, and that
disagreement surfaces as "the nightly job ran at the wrong hour in production only," which is
expensive to notice and trivial to prevent. `RepeatOptions extends Omit<ParserOptions, 'iterator'>`
and `ParserOptions.tz` exists, so per-job `tz` is native to BullMQ and costs nothing there;
`cron-parser` gives `memory` the same.

## Architecture

### Public API

```ts
// server/jobs/digest.ts
export default defineJob({
  cron: '0 9 * * *',
  handler: async (ctx) => {
    ctx.cron // { tick: number, expression: string, tz: string } | undefined
  },
})

// Object form, with a timezone and a static payload
export default defineJob({
  input: z.object({ scope: z.enum(['daily', 'weekly']) }),
  cron: {
    expression: '0 9 * * MON',
    tz: 'America/Toronto',
    payload: { scope: 'weekly' },
  },
  handler: async ctx => send(ctx.payload.scope),
})

// Deduplication
export default defineJob({
  unique: true,                              // lock: one queued-or-running at a time
  uniqueId: payload => `invoice:${payload.id}`,
  handler: async ctx => charge(ctx.payload),
})

export default defineJob({ unique: { ttl: 60_000 } })                   // throttle
export default defineJob({ unique: { ttl: 5_000, debounce: true } })    // debounce
```

`DefineJobOptions` gains `cron` and `unique`/`uniqueId`
([handlers/defineJob.ts:5-14](../src/runtime/server/handlers/defineJob.ts)). Both are carried onto
`JobDefinition` and into `RegistryEntry`
([supervisor.ts:27-32](../src/runtime/server/supervisor.ts)), because — exactly as with
`attempts` and `backoff` — the producer is the only place that can attach them at `add()` time.

**Cron jobs stay manually enqueueable.** They appear in the generated `ConciergeJobMap` like any
other job. That is what makes dashboard run-now a `enqueue` call rather than a new write path.

### Cron reconciliation

Runs once at boot, inside `startConsumers()`, on any instance whose role is not `web`
([supervisor.ts:203-248](../src/runtime/server/supervisor.ts)). Cron produces work; workers own
work. A `web`-only instance reconciling would write schedules for queues it does not consume.

For each queue in `config.worker.queues`:

1. Build the declared set — every job in `config.jobs` with a `cron` that targets this queue.
2. `upsert` each one. Idempotent; a changed expression reuses the id and updates in place rather
   than orphaning.
3. `list` the queue's existing schedulers.
4. `remove` every listed scheduler that is **concierge-owned** and not in the declared set.

The scheduler id is `concierge:<jobName>` — the job name, which build-time `duplicate-name`
validation already guarantees unique, under a fixed namespace prefix.

**The prefix is what makes the sweep safe to run on a queue this module does not exclusively own.**
Pruning by "not in the declared set" alone would delete unrelated BullMQ repeatable jobs on the
same queue the first time a worker boots — which would make adopting concierge destructive to
whatever was already there. The ownership check runs before the declared-set check, so a foreign
scheduler is never a removal candidate at all.

**The sweep must prune against the declared set for that queue, computed from the full scanned job
list — never from the subset of jobs this instance happens to handle.** Codegen emits every job to
every instance, so the full list is available. An instance whose `worker.queues` has been narrowed
by a `NUXT_CONCIERGE_*` override sweeps only its own queues, which is self-consistent, but means
**at least one running instance must declare the full queue set** or schedules on the undeclared
queues are never reconciled at all. Documented as a constraint, not guarded — guarding it requires
knowing the intended global set, which no single instance has.

### The scheduling SPI

Follows spec 4's pattern exactly: presence *is* the capability.

```ts
export interface ScheduleSummary {
  id: string
  jobName: string
  queue: string
  expression: string
  tz: string
  /** Next fire time, when the driver knows it. */
  next?: number
  /** Ticks produced so far, when the driver tracks it. */
  iterationCount?: number
}

export interface DriverScheduling {
  upsert: (queue: string, schedule: {
    id: string
    jobName: string
    expression: string
    tz: string
    payload?: unknown
  }) => Promise<void>
  list: (queue: string) => Promise<ScheduleSummary[]>
  remove: (queue: string, id: string) => Promise<void>
}

export interface ConciergeDriver {
  // ...
  readonly schedule?: DriverScheduling
}
```

The rejected alternative — a `capabilities.cron` boolean alongside optional methods — permits a
driver declaring support it lacks, or the reverse, and typechecks fine. Same reasoning that gave
`introspect` its shape ([drivers/types.ts:148-158](../src/runtime/server/drivers/types.ts)) and
that gave `validateOnEnqueue` a `void` return: make the inconsistent state unrepresentable rather
than merely untested.

`list` is deliberately unpaginated. Schedules are declared in source, so their count is bounded by
the size of the codebase rather than by traffic — unlike jobs, where `MAX_LIMIT` exists for a
reason. `getJobSchedulersCount()` is available if that assumption ever stops holding.

### Tick metadata

`JobContext` ([runtime/server/types.ts:44-51](../src/runtime/server/types.ts)) gains:

```ts
/** Present only for a job produced by a schedule. */
cron?: { tick: number, expression: string, tz: string }
```

`tick` is the scheduled fire time, not the time the handler started — they differ by queue latency,
and the scheduled time is the one that is stable across a retry. That stability is the entire point:
it gives a handler a natural idempotency key for the at-least-once guarantee, which is the closest
this spec comes to answering the concern that motivated it.

The driver populates it from the scheduler's own metadata. For `bullmq` that is the produced job's
scheduling information; for `memory` it is the fire time the timer computed.

### Static payload validation

A job may declare both `input` and `cron`. If the cron payload does not satisfy the schema, spec
3's consumer-side validation classifies the failure as *permanent*
([defineJob.ts:60-73](../src/runtime/server/handlers/defineJob.ts)) — so the job dead-letters on
every tick, forever, and nothing about the symptom points at the schedule.

**Validated at boot**, once, per job with both. Build time cannot do it: spec 3 established that
validation requires *executing* a schema, which is why AST extraction was dropped rather than
deferred. Boot can, because the schema is a live object by then. A failure is a startup error,
consistent with how `resolveRole` and `validateHistoryLimit` already treat config mistakes
([options.ts:139-158](../src/options.ts)).

A job with `input` and a `cron` that supplies *no* payload is the same error, caught the same way —
`undefined` is not going to satisfy an object schema, and finding that out at boot beats finding it
out at 9am.

### Deduplication semantics

Verified by tracing `moveToFinished-14.js` in the installed bullmq 5.63.0, not from documentation:

| Mode | API | BullMQ | Guarantee |
| ---- | --- | ------ | --------- |
| **Lock** | `unique: true` | `deduplication: { id }` | Key has no expiry. `removeDeduplicationKeyIfNeededOnFinalization` deletes it when the job moves to completed **or terminally failed**. Lock spans queued *and* executing. |
| **Throttle** | `unique: { ttl }` | `deduplication: { id, ttl }` | Key carries a `PX` expiry. On finalization `PTTL` is positive, so neither delete branch fires and the key survives to expiry. At most one run per window. |
| **Debounce** | `unique: { ttl, debounce: true }` | `deduplication: { id, ttl, extend: true, replace: true }` | `extend` re-arms the TTL on each suppressed enqueue; `replace` supersedes the pending delayed job. A burst collapses to one run after the quiet period. |
| ~~Serialize~~ | — | — | **Not supported.** Needs a runtime lock. See Decisions. |

Two details that are easy to get wrong and that the conformance table must pin:

- **Terminal failure releases a lock-mode key; an intermediate failure does not.** Retries move a
  job through `moveToDelayed`/`retryJob`, not `moveToFinished`, so a job with `attempts: 3` holds
  its key across all three.
- **`debounce` is deprecated in BullMQ in favour of `deduplication`** and must not be built on,
  even though it takes the identical `DeduplicationOptions` shape.

### The dedup key

`uniqueId: (payload) => string` runs on the producer, alongside `validateOnEnqueue`
([utils/useQueue.ts:46](../src/runtime/server/utils/useQueue.ts)). It must be pure, for the same
reason spec 3 requires schema validators to be pure — though here the constraint is sharper, since
an impure key does not fail loudly, it just stops deduplicating.

The default key, when `unique` is set and `uniqueId` is not, is **the job name plus a hash of the
serialized envelope** — the exact devalue string the driver is about to store. Two enqueues whose
payloads serialize identically deduplicate; two whose payloads do not, do not.

**This is deliberately not an order-insensitive canonical form, and that is a reversal.** An
earlier version of this spec required one: recursive key sorting plus a defined encoding per exotic
type, so that `{a: 1, b: 2}` and `{b: 2, a: 1}` would share a key. That requirement was attempted
and abandoned after three implementation rounds, each of which fixed the cited examples and left
the mechanism open. The reason is structural: a hand-written canonical form dispatches on
`instanceof` and prototype identity, devalue dispatches on the `Object.prototype.toString` brand and
on shape, and **any value falling in the gap between those two dispatchers gets devalue's
insertion-ordered walk anyway**. Closing the gap means mirroring devalue's entire branch list and
keeping it mirrored across versions. Concrete escapees found in review: a `URL` subclass carrying
its own property, objects whose data is inherited one link up a null-prototype chain, and
cross-realm `Map`/`Set`.

Hashing the envelope has one dispatcher, so the gap cannot exist by construction.

**The cost, stated plainly:** two payloads that serialize differently do not deduplicate, which
includes object key order, `Map`/`Set` insertion order, whether two equal sub-objects are the same
reference or two, and whether a bag was built with `Object.create(null)`. Weighed against the
alternative, this is the better failure. Order sensitivity means deduplication is *less effective*
— the job runs twice, which every handler must already tolerate under at-least-once delivery. The
bugs it replaces meant a job was *silently suppressed and never ran*. `uniqueId(payload)` remains
the escape hatch for anyone who needs exact control, and it is what the README should point at for
payloads assembled from more than one call site.

For a cron job with no payload the key reduces to the name plus the hash of `undefined`, which is
stable.

### The enqueue return

```ts
enqueue: (...) => Promise<{ id: string, deduplicated: boolean }>
```

Additive to today's `{ id }`, so nothing that reads `.id` breaks. `deduplicated: true` means the
call was suppressed and `id` is the *existing* job's id.

BullMQ hands back the existing job's id with no signal at all, which is the part not copied.
Silent deduplication turns "why didn't my job run?" into a debugging session; a boolean turns it
into a return value.

### Per-driver implementation

**`bullmq`** — the reference. `upsertJobScheduler(id, { pattern, tz }, template)` /
`getJobSchedulers()` / `removeJobScheduler(id)`, all verified present on `Queue` in 5.63.0.
Deduplication passes `DeduplicationOptions` straight through on `add()`; no translation layer,
for the same reason `BackoffOptions` mirrors BullMQ's shape deliberately — a translation layer is
where an off-by-one hides.

**`memory`** — in-process timers off `cron-parser`, and a dedup key map.

- Schedules: compute the next fire time, `setTimeout`, enqueue, recompute. Timers are `unref`'d and
  torn down in `close()`, matching how the heartbeat interval is handled
  ([supervisor.ts:230-231](../src/runtime/server/supervisor.ts)) — an un-torn-down timer leaking
  into the rest of the suite is a known hazard in this codebase.
- Lock mode: set on enqueue, released in `remember()`
  ([drivers/memory.ts:111](../src/runtime/server/drivers/memory.ts)), which is already the single
  point every terminal transition passes through.
- Throttle: an expiry timestamp checked **lazily on read**, never a timer per key. A timer per key
  is a leak the driver would have to track and tear down, for no benefit in a driver whose entire
  lifetime is bounded by the process.
- Debounce: drop the pending delayed record and re-add. The fiddliest of the three, and the one
  whose conformance case gets written first.

Non-durability is unchanged and unhidden: a restart loses every schedule and every dedup key,
exactly as it loses the bounded history. There is no catch-up to perform because there is no
record that a tick was missed.

**`sync`** — omits `schedule` entirely; ignores `unique`. Boot warns on a `cron` job.

### Dashboard

One new **Schedules panel**: job name, queue, expression, timezone, next fire, iteration count,
sourced from `driver.schedule.list()`. Plus a **run-now** button, which is `enqueue` with the
static cron payload — and deliberately leaves `ctx.cron` **undefined** rather than fabricating a
tick. The natural implementation would route through `EnqueueOptions.cron`
([drivers/types.ts](../src/runtime/server/drivers/types.ts)), but that field is honoured by
`memory`'s own scheduler only — `bullmq` derives its tick metadata from the produced job's own
`repeatJobKey`/`prevMillis` instead and ignores anything a producer passes in, and `sync` ignores
it too. Populating it from a manual run-now would work in dev on `memory` and do nothing in
production on `bullmq`: a dev-only feature. `ctx.cron === undefined` is also arguably the more
honest signal for a manual run anyway — it distinguishes "a human pressed a button" from "the
schedule fired" — so a handler must treat `ctx.cron` as optional and never do `ctx.cron!.tick`.
Retry already established that the dev dashboard performs writes
([drivers/types.ts:128-142](../src/runtime/server/drivers/types.ts)), so this needs no new
security argument — spec 4's registration-time gating covers it unchanged.

**No dedup panel.** A deduplicated job does not exist to be listed. The only real signal is
BullMQ's `deduplicated` event, and consuming it would mean introducing a push mechanism into an
introspection SPI that is deliberately pull-based. Instead, `JobDetail` gains
`deduplicationId?: string` — **first-class, not `raw`.** The rule: *if the conformance table
asserts on it, it cannot live in `raw`*, because `raw` is documented as driver-specific and
display-only with nothing branching on it, and both `memory` and `bullmq` implement dedup
identically enough to be held to one table.

Three constraints inherited from spec 4 apply directly to this new surface, called out here
because they are exactly the kind that get missed on a new route:

1. **Every new driver read goes through `withTimeoutOrThrow`.** The spec 4 record found this bug
   twice in one task. BullMQ's connections use `maxRetriesPerRequest: null`, so a command issued
   while disconnected sits in ioredis's offline queue and *never settles* — it does not reject.
   `driver.isHealthy()` is not a safe gate on its own. A schedules panel is one more unbounded read
   over the identical connection.
2. **`/overview` gains a `schedulable` flag** alongside `introspectable`, so the panel explains
   absence rather than rendering a confident empty table. `sync` has no `schedule` at all, and an
   empty list from a driver that cannot schedule is indistinguishable from a codebase with no cron
   jobs.
3. **`build:client` still runs LAST** in `prepack` and `dev:prepare`. Adding a panel does not
   change this, and the failure is silent — the tarball simply ships without `dist/client`.

### Configuration

```ts
export interface CronOptions {
  /**
   * Master switch for every declared schedule.
   *
   * `false` does not skip reconciliation — it runs it with an EMPTY declared
   * set, so the sweep removes every schedule on every declared queue and
   * upserts none. Disabling cron therefore leaves Redis clean rather than
   * stranding schedules that resume firing the moment any instance of an
   * older build boots.
   */
  enabled: boolean
}
```

Default `true`. Added to `ModuleOptions` as `cron?: Partial<CronOptions>` and to
`ResolvedConciergeOptions` as `cron: CronOptions`, resolved through `resolveModuleOptions` — which
remains the single resolution point, with no `defaults:` on `defineNuxtModule`.

The empty-declared-set semantics are the whole point, and they are what makes the switch safe to
flip. The rejected alternative — skipping reconciliation entirely when disabled — leaves every
schedule live in Redis with no worker upserting or pruning it, so a stale scheduler keeps producing
jobs against the disabled deployment. "Off" has to mean off in Redis, not merely off in this
process.

The consequence to state plainly: **an instance with `cron.enabled: false` will prune the schedules
of an instance with it `true`**, because neither knows about the other. This is a deployment-wide
switch, not a per-instance one, and setting it inconsistently across a fleet makes schedules flap.

## Inherited constraints

Restated from the three decisions records because they bear directly on this work and violating
any of them fails silently.

- **`JobDefinition.handler` stays property-syntax.** Its contravariance forces callers through
  `run`, which is where consumer-side validation lives. Adding `cron`/`unique` to `JobDefinition`
  must not disturb this, and collections must keep using `AnyJobDefinition`.
- **`EnqueueInputOf` must `infer` both type parameters**, and `__payloadTypes` stays. Any change
  to `JobDefinition`'s member set risks the extraction silently yielding `unknown` for every job
  while the generated map still looks correct.
- **Never `export *` inside a generated `.d.ts`**, and every `#concierge*` alias needs a
  declaration in *both* the nitro and app graphs. If cron or dedup adds anything to codegen, it
  adds it twice.
- **`attempts` is TOTAL attempts including the first.** Never translate. The dedup lock's release
  on *terminal* failure depends on getting this right.
- **Consumer-side validation stays inside `run`.** Boot-time cron payload validation is additional
  to it, never a replacement.
- **Resolve scan paths against `rootDir`, never `srcDir`.**
- **Registration-time gating is the dashboard's entire security boundary.** No runtime flag
  re-enables the Schedules panel in production.

## Testing

### The conformance table

One shared table across `memory` and `bullmq`, never two independent files — that is how `depth()`
drifted in phase 1. The bullmq half is guarded on `REDIS_URL`, which CI supplies.

Cron cases:

- Next-fire computation for a given expression, `tz` and reference time — including a DST
  transition in a non-UTC zone, which is where a homegrown `memory` implementation and
  `cron-parser` would diverge if `memory` ever stopped using it.
- `upsert` is idempotent: two upserts of the same id yield one scheduler, and `list` returns one
  row.
- `upsert` with a changed expression updates in place — one row, new expression, not two.
- The sweep removes exactly the undeclared, and leaves the declared untouched.
- The sweep is scoped to its queue: a schedule on queue B survives a sweep of queue A.
- `ctx.cron.tick` is the scheduled time, and is *identical across a retry* of the same tick.
- Missed windows produce at most one catch-up run — asserted as a bounded count, not as exactly
  one, following the established convention for at-least-once duplicates.

Dedup cases, one per mode plus the boundaries:

- **Lock**: second enqueue while queued returns `deduplicated: true` with the first id; the key
  releases on completion; it also releases on *terminal* failure; and — the case most likely to be
  got wrong — it does **not** release on an intermediate failure with `attempts: 3`.
- **Throttle**: the key survives finalization and the window is enforced from first enqueue; a
  second enqueue after expiry succeeds.
- **Debounce**: a burst of N enqueues within the window yields exactly one run, and its payload is
  the *last* one enqueued, not the first — that is what `replace` means and it is the assertion
  that distinguishes debounce from throttle.
- The default key: two enqueues of an **equal** payload deduplicate, and two of a **different**
  payload do not. Both halves, because either alone is satisfied by a constant key or by no key at
  all. Asserted at unit level against the derivation as well, not only end-to-end.
- The default key's **order sensitivity is asserted, not merely tolerated**: `{a: 1, b: 2}` and
  `{b: 2, a: 1}` produce different keys. That is a decision this spec took with its eyes open (see
  The dedup key), and a test is what stops it from being silently "fixed" back into the canonical
  form that failed three times.
- Exotic payload values are distinguished **by value** through the same path — two different
  `Date`s, two different `RegExp`s, two different `URL`s, and a `URL` subclass with two different
  hrefs, and the collapse of two differing only in an own property. The former is the specific
  regression that killed the canonical form and must not come back; the latter is correct — devalue
  brands and drops own properties on a subclass, so the two enqueues would deliver an identical
  payload, and suppressing one is what deduplication is for.
- `sync` reports `deduplicated: false` and runs both.

### Unit

- Default key derivation, directly: equal payloads match, different payloads differ, and exotic
  values (`Date`, `RegExp`, `URL`, `Map`, `Set`) are distinguished by value through the envelope.
  The order sensitivity is asserted rather than tolerated.
- Reconciliation logic as a pure function over (declared set, listed set) → (upserts, removals),
  so the sweep's set arithmetic is tested without a driver at all.
- Boot-time cron payload validation: a valid payload boots, an invalid one throws, and a job with
  `input` and no cron payload throws.
- `cron: '...'` string shorthand and object form resolve to the same internal shape.
- `concierge.cron.enabled: false` reconciles with an empty declared set — zero upserts, and every
  existing schedule on every declared queue removed. Asserted as both halves, since "no upserts"
  alone is satisfied by an implementation that skips reconciliation entirely.

### Type tests

Under `pnpm test:types`. Every negative case paired with the positive case that must compile —
`@ts-expect-error` passes if *any* error occurs on the line, including an unrelated typo.

- `ctx.cron` is optional and correctly shaped.
- `uniqueId` receives the job's *input* payload type, not the output type — it runs on the producer,
  before the transform.
- `enqueue` returns `{ id, deduplicated }` and both are correctly typed.
- A cron job is still present in `ConciergeJobMap` with its payload type intact.

### Lifecycle

Against real Redis, spawning the built output.

- A schedule fires, the job runs, and `ctx.cron.tick` matches the expected time.
- Two worker processes booting concurrently produce **one** scheduler and one run per tick — the
  case that would justify leader election if it failed.
- A schedule removed from source is pruned on the next boot and stops firing.
- A dedup lock held by a job in flight survives a force-close and is released by the eventual
  terminal transition, not stranded.

### The question to ask of every assertion

*Would this fail if the behaviour were removed?*

Spec 3 and spec 4 each found defects in their own plan's reference code — ten in spec 4 alone —
and the dominant failure shape across all three phases was **a test that exists, passes, and proves
nothing**. Two places in this spec are unusually exposed:

- **A dedup test that passes because nothing was enqueued twice.** Assert both halves: the second
  call returned `deduplicated: true` *and* the handler ran exactly once. Either alone is satisfied
  by a broken implementation.
- **A cron test that passes because the window was too generous.** A bound loose enough to admit a
  wrong `tz` or an off-by-one tick is the same defect as the exponential-backoff ratio assertion
  phase 1 shipped: it cannot discriminate the regression it exists for.

## Breaking changes

- **`enqueue` returns `{ id, deduplicated }`.** Additive; `.id` readers are unaffected.
- **`JobContext` gains optional `cron`.** Additive.
- **`ConciergeDriver` gains optional `schedule`.** Additive for consumers; a third-party driver
  simply omits it.
- **`JobDetail` gains optional `deduplicationId`.** Additive.
- **`concierge.cron`** is a new config key with a working default.

Nothing here requires a consumer to change code. Per the project's alpha posture, that is a
convenience rather than a constraint.

## Dependencies

- **`cron-parser`** moves from transitive to a direct, pinned dependency. It is currently present
  at 4.9.0 only because BullMQ depends on it; `memory` needs it explicitly, and relying on another
  package's transitive resolution is exactly the kind of silent breakage the `packageExtensions`
  pin already demonstrates. Pin to the version BullMQ resolves, so both use one copy.
- No other additions. `croner@10.0.1` is present via Nitro's scheduled-tasks feature and is
  deliberately not used — a second cron implementation in the tree would mean `memory` and `bullmq`
  parsing expressions with different libraries, which is a conformance divergence waiting to
  happen.

## Deferred

| # | Item | Why not here |
| - | ---- | ------------ |
| 1 | Execution serialization (`while_executing`, global cron overlap) | Needs a lease-based runtime lock with liveness renewal and crash release. Its own spec. |
| 2 | Imperative / per-tenant schedules with an `externalId` | A different feature with its own storage and lifecycle, not a variation on declared cron. |
| 3 | `every: <ms>` interval schedules | Second scheduling syntax doubles `memory`'s conformance surface for no requested use case. |
| 4 | `limit` / `startDate` / `endDate` on a schedule | Same. |
| 5 | Backfill of missed ticks | Nobody in the ecosystem does it; the failure mode is a thundering herd after an outage. |
| 6 | A `deduplicated` event stream in the dashboard | Requires a push mechanism in a deliberately pull-based SPI. |
| 7 | Transactional outbox | Unchanged from phase 1: still the right answer to "enqueued but the transaction rolled back," still orthogonal to this. |
