# Spec 3 — Job API, typed enqueue and payload validation

Phase 1 shipped the part users do not forgive getting wrong: workers that survive a deploy.
Nothing in it is a reason to *choose* this module over wiring BullMQ directly. This spec is that
reason.

The deliverable is that `enqueue` knows what every job's payload looks like, at compile time,
without the enqueueing process importing handler code it will never run — and that a payload
which does not match is rejected loudly on both sides of the queue rather than dead-lettered
silently.

Prerequisite reading: [the phase 1 decisions record](2026-08-13-phase1-decisions.md). Several of
its constraints are build-breaking and this spec depends on them.

## Scope

### In scope

- `defineJob<Payload>` with a typed `ctx.payload`
- A generated name → payload type map, making `useQueue().enqueue` generic over it
- Payload validation against any Standard Schema validator, on both enqueue and execute
- Per-job `attempts` and `backoff`, with module-level defaults
- A retry contract the three drivers actually agree on
- Type-level tests, and a `typecheck` step that runs in CI

### Out of scope

Cron; dedup / `unique`; lazy handler loading and lean per-role bundles; the transactional
outbox; per-job middleware and a `failed` hook; `jitter`; exposing `lockDuration`. See
[Deferred](#deferred) for where each goes.

### Corrections to the phase 1 design document

Two recommendations in [spec 1](2026-08-12-concierge-v2-lifecycle-design.md)'s "decisions
carried forward to spec 3" do not survive contact with this design. Both are corrected there.

**`const Name extends string` on `defineJob` is unnecessary.** It is load-bearing in
`nuxt-cf-jobs` because the job name is a property of the runtime options object, so the type
system is the only thing that can carry the literal. Here `scanJobs()` derives names from file
paths at build time (`src/scan.ts:61`), so codegen emits the map with literal keys and
`keyof ConciergeJobMap` is a literal union for free. Adopting the `const` modifier would also
have foreclosed the chosen API shape, since a `const` type parameter and an explicit
`defineJob<Payload>` type argument cannot coexist — TypeScript has no partial type-argument
inference.

**AST extraction of `defineJob` metadata is dropped, not deferred.** Nothing replaces it; the
[producer/consumer decision](#why-there-is-no-ast-extraction) removes the need for it. The phase
1 document calls it "the important one", which it was under the assumptions available at the
time. It is not pending work.

## Decisions

| Decision | Choice | Rationale |
| -------- | ------ | --------- |
| Handler signature | Unchanged — `(ctx)`, payload inside | Matches Nitro's own `defineTask` (`run(event)`, `nitropack/dist/types/index.d.ts:108`) and `defineEventHandler`. Also means phase 1's driver SPI, lifecycle harness and playground do not move. |
| Payload declaration | `defineJob<Payload>` type argument, or inferred from `input` | Two overloads. A named interface plus an explicit type argument is the established convention in this codebase. |
| Schema library | Any Standard Schema v1 validator | Types-only dependency, zero runtime. Zod, Valibot and ArkType all implement it, and it is already how `UForm` and h3's validated-body helpers accept schemas. |
| Producer bundle | Eager static imports retained | The lean-bundle problem is a bundling concern, not a job-API concern. See [below](#why-there-is-no-ast-extraction). |
| What gets enqueued | The **raw** input; the consumer's validated output is what reaches the handler | The transform is *applied* exactly once, in the process whose schema is authoritative. Both sides still *call* `validate`; see [Validation data flow](#validation-data-flow). |
| Validation failure | Permanent, never retried | A payload this build cannot accept fails identically on every attempt. Same treatment `UnsupportedEnvelopeError` already gets. |
| `attempts` semantics | Total attempts, including the first | Matches BullMQ, so pass-through needs no arithmetic. |
| Default retries | `3`, exponential, `1000ms` | A background-job library whose default is no retries has the wrong default. This is a **behaviour change**; see [Breaking changes](#breaking-changes). |
| Driver agreement | `memory` matches `bullmq` exactly, verified by one shared table | Two independent test files is how `depth()` drifted. |

## Architecture

### Public API

Without a schema — the payload type is declared as an interface and passed as a type argument:

```ts
// server/jobs/send-email.ts
import { defineJob } from '#concierge-handlers'

export interface SendEmailPayload {
  to: string
  subject: string
}

export default defineJob<SendEmailPayload>({
  queue: 'default',
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  handler: async (ctx) => {
    ctx.payload.to    // string
    ctx.attempt       // 1-based, unchanged from phase 1
  },
})
```

With a schema — the type argument disappears, because the schema supplies both types:

```ts
import { z } from 'zod'

const input = z.object({
  to: z.string().email(),
  subject: z.string().default('(no subject)'),
})

export default defineJob({
  queue: 'default',
  input,
  handler: async (ctx) => {
    ctx.payload.subject   // string — InferOutput, default already applied
  },
})
```

Two overloads, schema first so it wins whenever `input` is present:

```ts
export function defineJob<S extends StandardSchemaV1>(
  opts: DefineJobOptions<StandardSchemaV1.InferOutput<S>> & { input: S },
): JobDefinition<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>>

export function defineJob<Payload = unknown>(
  opts: DefineJobOptions<Payload> & { input?: never },
): JobDefinition<Payload, Payload>
```

`input?: never` on the second overload is what makes `defineJob<P>({ input: schema })` a
compile error rather than a silent case where two sources of truth disagree about the payload
type.

`JobDefinition<In, Out>` carries **two** handler fields and one type-only field:

```ts
export interface JobDefinition<In = unknown, Out = In> {
  name: string
  queue: string
  /** As authored. Carries Out. */
  handler: (ctx: JobContext<Out>) => Promise<void> | void
  /** Driver-facing: validates, then delegates to `handler`. */
  run: (ctx: JobContext<unknown>) => Promise<void> | void
  input?: StandardSchemaV1<In, Out>
  attempts?: number
  backoff?: BackoffOptions
  /** Type-only. Never assigned, never read. */
  readonly __payloadTypes?: { input: In, output: Out }
}
```

An earlier draft of this section claimed both parameters were recoverable from real fields and
that no phantom was needed. That was wrong on two counts, both found while writing the
implementation plan:

- **The driver-facing handler cannot be `JobHandler<Out>`.** A driver has no payload type
  information and must be handed a `JobHandler<unknown>`, and `JobHandler<Out>` is not assignable
  to it — parameter contravariance requires `JobContext<unknown>` to be assignable to
  `JobContext<Out>`, which is false for every concrete `Out`. Hence `run` alongside `handler`.
  `run` is also the natural and correct home for consumer-side validation, per
  [the error taxonomy](#error-taxonomy).
- **`In` is not reliably inferable without a carrier.** For a job that declares no schema, `In`
  appears in no member at all, and an interface whose type parameters appear in no member is
  structurally identical for every instantiation — so extraction silently yields `unknown` for
  every job while the generated map still looks correct. `__payloadTypes` exists solely to give
  both parameters a member to be inferred from.

`JobContext` gains a type parameter defaulting to `unknown`, so bare `JobContext` stays valid.

### Enqueue

`useQueue()` is retained and made generic. No second way to enqueue is added:

```ts
const { enqueue } = useQueue()

await enqueue('send-email', { to: 'a@b.c', subject: 'hi' })
await enqueue('send-email', { to: 'a@b.c' }, { delay: 5_000 })

await enqueue('send-emial', { /* … */ })   // ✗ not assignable to keyof ConciergeJobMap
await enqueue('send-email', { to: 1 })     // ✗ number is not assignable to string
```

A per-job accessor (`jobs.sendEmail.enqueue(payload)`) was considered and rejected: job names
are paths (`mail/send`, `src/scan.ts:51`), so it would need a name-mangling scheme to produce
valid identifiers, and mangling collisions would reintroduce the duplicate-name class of bug
`scanJobs` exists to catch.

The first error above replaces the runtime `no job named "…" is registered` throw at
`src/runtime/server/utils/useQueue.ts:22`. **That runtime check stays** — a JavaScript consumer,
or a stale build, can still reach it.

### Codegen

An empty, augmentable interface ships in the module's own types:

```ts
export interface ConciergeJobMap {}
```

A generated type template fills it from the scan, emitted into **both** the nitro and app
graphs:

```ts
declare module '#concierge' {
  interface ConciergeJobMap {
    'send-email': import('<abs>/runtime/server/types').EnqueueInputOf<
      typeof import('/abs/path/server/jobs/send-email')['default']
    >
    'mail/send': import('<abs>/runtime/server/types').EnqueueInputOf<
      typeof import('/abs/path/server/jobs/mail/send')['default']
    >
  }
}
```

`enqueue` reads through it:

```ts
enqueue<K extends keyof ConciergeJobMap>(
  name: K,
  payload: ConciergeJobMap[K],
  opts?: EnqueueJobOptions,
): Promise<{ id: string }>
```

Three details here differ from this section's first draft, each corrected by implementation:

- **The specifier is `#concierge`, not a package subpath.** Ambient `declare module` blocks with
  matching specifiers merge, which is the entire mechanism — the empty `ConciergeJobMap` declared
  alongside `useQueue` and the filled one above become one interface. Augmenting any other
  specifier creates a second, unrelated interface that `useQueue` never sees, and every `enqueue`
  silently falls back to the empty one with no error anywhere.
- **`EnqueueInputOf` is applied at generation time, not at the call site.** `TypedQueue<Map>` types
  its payload as `Map[K]` directly, so the map must hold payload types rather than job definitions.
  Emitting the bare definition made a *correct* call fail with TS2353. The module qualification on
  `EnqueueInputOf` is load-bearing and easy to lose: an unresolvable name inside a generated
  `.d.ts` is swallowed by `skipLibCheck`, leaving `Map[K]` an error type and every payload
  effectively `any`.
- **It is emitted into both graphs, not nitro-only.** Nitro's generated `nitro-routes.d.ts`
  references every server route handler to type `$fetch`, which pulls them into the app program —
  so a route importing `#concierge` fails there without an app-graph copy. The same applies to
  `#concierge-handlers`, because this map's own `typeof import(<job file>)` drags job modules into
  the app program too.

`EnqueueInputOf` itself:

```ts
type EnqueueInputOf<T> = T extends JobDefinition<infer In, infer _Out> ? In : unknown
```

Both parameters must be `infer`red, not pinned. Writing `JobDefinition<infer In, unknown>` looks
equivalent and is not: matching it requires `handler: (ctx: JobContext<Out>) => …` to be
assignable to `(ctx: JobContext<unknown>) => …`, and parameter contravariance makes that false
for every concrete `Out`. The conditional would fall through to `unknown` for every job — every
payload silently unchecked, with the map generated and looking correct. One of the type tests
exists specifically to catch this.

Interface augmentation rather than emitted runtime code, for three reasons: it is how Nitro
types `$fetch` against server routes (`declare module 'nitropack/types' { interface InternalApi
{ … } }`), so it is an idiom a Nuxt user already has intuitions about; `typeof import(...)` is
type-only and adds nothing to any bundle; and it composes with `addTypeTemplate`, which the
module already uses.

Constraints this must respect, all carried from phase 1:

- **`{ nitro: true }` on the type template.** Without it the declaration leaks into client
  typings — the bug documented at `src/templates.ts:205`.
- **Absolute paths from `scanJobs()` output, resolved against `rootDir`.** One source of truth
  for names, and no exposure to the `srcDir`/`app/` trap.
- **The runtime plugin template stays free of TypeScript syntax.** Only object literal fields
  (`input`, `attempts`, `backoff`) are added to the existing `jobs` array. No annotations enter
  the emitted file.
- **`Supervisor.routes` becomes a registry.** `useQueue` now needs each job's schema and retry
  options, not just its queue, so `Map<string, string>` becomes
  `Map<string, { queue, input?, attempts?, backoff? }>`. Call sites:
  `src/runtime/server/supervisor.ts:121`, `src/runtime/server/utils/useQueue.ts:19`.

**A project with zero jobs gets `keyof ConciergeJobMap` = `never`**, so any `enqueue` call fails
to compile with a somewhat opaque message. This is accepted rather than papered over with a
`string` fallback: that fallback would also mask a stale or failed codegen, which is the failure
mode that would cost the most time to diagnose.

### Why there is no AST extraction

The phase 1 document's plan was to read `queue`, `attempts` and schema *flags* out of the
`defineJob({ … })` source text at build time, generate a plain route table, and let a `web`
process route enqueues without importing job modules — so that `sharp`, `puppeteer` and an SMTP
client never enter the web bundle.

Dual-side validation breaks that plan. For `enqueue` to reject a bad payload at the call site,
the producer must **execute** the schema. Reading source text establishes that a schema exists;
it does not yield a runnable object. Obtaining one requires importing the module the scheme
existed to avoid importing.

Three resolutions were considered:

1. **Consumer-only runtime validation.** Producer gets compile-time types only. Cheapest, but a
   bad payload surfaces in a worker minutes later instead of throwing at the call site.
2. **Producer lazily imports the module when a schema exists.** True dual-side, but the first
   `enqueue` of a job loads that job's entire dependency tree anyway — it pays the full AST
   extraction cost and then defeats its own purpose on every job that validates.
3. **Move the expensive half out, so job modules are cheap to import** — a `load: () => import('./x.handler')`
   thunk resolved only by the worker. Full dual-side validation with no AST layer, but it splits
   one job across two files, and which file a line belongs in depends on how expensive its
   imports are.

**None was adopted. Eager static imports are retained** — the phase 1 behaviour, unchanged
(`src/templates.ts:74`). The reasoning is that the lean-bundle problem is not a job-API problem.
It is a "which code ends up in which process's bundle" problem, the same family as the
`worker: { entry: 'separate' }` item phase 1 already deferred. Those two belong together, solved
later with a real bundling mechanism, rather than one of them being smuggled into the job API as
an authoring convention users must remember.

Three things make deferring safe:

- **It is not a regression.** Eager importing is what `2.0.0-alpha` ships today.
- **Nothing is foreclosed.** Adding `load` later is one new optional key; existing `handler:`
  jobs keep working untouched.
- **It deletes the most defect-prone component in the spec.** AST extraction is static analysis
  that must cope with spreads, re-exports and non-literal values, and it *silently* misreads
  anything it does not understand — the same failure signature as a scan returning `[]` and
  raising nothing. The phase 1 retro found that essentially every defect originated in the
  plan's own reference code; this was the component most likely to repeat that.

What is accepted in exchange: a `web` process keeps loading handler dependencies at boot, which
costs real cold-start time on serverless. Spec 4's DevTools tab is the better place to surface
which jobs import eagerly — a diagnostic cannot silently misread the way an analyzer can.

### Validation data flow

```text
enqueue('send-email', raw)
  │
  ├─ registry lookup ──── no such job ──────────→ throw (runtime backstop)
  │
  ├─ await input?.~standard.validate(raw)
  │     └─ issues ──────────────────────────────→ throw JobPayloadInvalidError   ✗ nothing enqueued
  │     └─ ok ─→ DISCARD the output
  │
  └─ encodePayload(raw) ─→ driver.enqueue(queue, { name, payload, attempts, backoff, delay })

worker picks up job
  │
  ├─ decodePayload(job.data) ─── bad envelope ──→ UnsupportedEnvelopeError (retryable: false)
  │
  ├─ await input?.~standard.validate(decoded)
  │     └─ issues ──────────────────────────────→ throw JobPayloadInvalidError (retryable: false)
  │     └─ ok ─→ KEEP the output
  │
  └─ userHandler({ ...ctx, payload: output })
```

Standard Schema's `validate` may return a promise, so both sites `await` it.

**The raw input is what gets serialized; the consumer's validated output is what reaches the
handler.** Producer-side validation is a pure check whose result is discarded — it exists only
to throw early. Each side therefore has exactly one job: **the producer fails fast, the consumer
is the authority.**

**What "exactly once" does and does not mean.** The transform is *applied to the payload* once:
the raw input is what gets serialized, and only the consumer's output reaches the handler, so a
value is never transformed twice. But **both sides call `~standard.validate`**, so a transform or
refinement *function* executes twice — once on the producer, whose result is thrown away.

That is harmless for a pure validator, which is what Zod, Valibot and ArkType give you. It is not
harmless for one with side effects: a `superRefine` that writes to a database, increments a
counter, or calls an external service will do so on both the producer and the consumer. **Schema
validators must be pure.** `validateOnEnqueue`'s doc comment says the same thing for the
neighbouring reason — a validator that mutates its input in place would half-transform what gets
serialized.

The alternative — enqueueing the transformed output and validating again — is a bug that only
appears in production. Given `input: z.object({ id: z.string().transform(Number) })`, a producer
validating `{ id: '42' }` holds `{ id: 42 }`; enqueue that, and the consumer's `z.string()`
receives `42` and fails. The job is correct at the call site and permanently dead in the worker.
Idempotent schemas (`.default()`, `z.coerce.date()`) survive this; anything that changes a type
does not.

The chosen shape falls out of Standard Schema's own type distinction, which is a good sign it is
right: `enqueue` takes `InferInput<S>` and `ctx.payload` is `InferOutput<S>`.

```ts
// input: z.object({ id: z.string().transform(Number) })
await enqueue('archive', { id: '42' })   // InferInput  — string
// handler: ctx.payload.id                 InferOutput — number
```

It costs one redundant schema run per execution when producer and consumer are the same build.
That is negligible against the work a job does, and it is exactly what buys safety across a
rolling deploy where they are *not* the same build.

### Error taxonomy

One class, `JobPayloadInvalidError`, with `readonly retryable = false` and structured
`issues` plus `jobName` fields.

That single `retryable` field is the whole driver integration. `isPermanentFailure`
(`src/runtime/server/drivers/bullmq.ts:52`) and the equivalent branch at
`src/runtime/server/drivers/memory.ts:97` already key off `retryable === false`, so a validation
failure becomes a BullMQ `UnrecoverableError` and skips the retry budget with **zero driver
changes**.

That only works because consumer-side validation lives inside the wrapper `defineJob` builds, so
it throws *inside* the driver's `try`. **This placement is load-bearing.** Validating before
handing the job to the driver would put the throw outside the driver's error handling, and the
permanent-failure classification would be lost.

`issues` stays on the error object as structured data so an API route can map a producer-side
failure to a 400 without string-parsing.

**Messages are redacted on the consumer side and not on the producer side.** This mirrors the
reasoning already written into `describeEnvelopeShape`
(`src/runtime/server/envelope.ts:38`): a consumer-side failure's message becomes BullMQ's
`failedReason`, which is persisted in Redis and logged. Standard Schema `Issue` messages can
embed received values, from two sources: **user-authored messages** (a `superRefine` or an
`error` callback that interpolates the input), and **other validators' defaults** — ArkType emits
`must be a string (was 5)`. Since the module accepts any Standard Schema validator, the message
carried into `failedReason` cannot be trusted regardless of what one library's defaults do this
major version. A consumer-side error therefore reports **issue paths and a count only, never
messages**. The producer-side throw carries full messages, because it returns to the caller that
just supplied the data, in that caller's own process, and never reaches the queue backend.

> An earlier draft justified this with Zod's enum message (`Invalid enum value. Expected 'a' |
> 'b', received 'c'`). That is **Zod v3** behaviour; v4 reports only the allowed options and does
> not echo the received value. The requirement is unchanged — the threat was never specific to
> Zod's defaults — but the example was wrong, and it mattered: a test fixture built on it made the
> redaction assertion unfalsifiable, since the value it asserted absent was never present to
> begin with. Found during implementation. The fixture now authors its own value-echoing message.

### Retry contract

```ts
concierge: {
  defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
}
```

Per-job values override module defaults. Resolution happens at **enqueue** time, because BullMQ
takes `attempts` and `backoff` as job options at `add()`. The producer has the resolved values
from the registry — **this works only because eager imports were retained**, so the two
decisions are coupled and should move together if either is revisited.

Semantics, verified against `bullmq@5.63.0` rather than assumed:

- `attempts` is **total** attempts including the first. `shouldRetryJob` tests
  `attemptsMade + 1 < opts.attempts` with `attemptsMade` at 0 on the first failure
  (`classes/job.js`).
- BullMQ's default is `attempts: 0` (`classes/job.js:82`), and `0 + 1 < 0` is false, so **a job
  that throws is currently never retried in production**. The bullmq driver never passes
  `attempts` (`src/runtime/server/drivers/bullmq.ts:149`).
- Exponential backoff for the k-th retry is `Math.round(2^(k-1) * delay)`
  (`classes/backoffs.js`), so the first retry waits exactly `delay`.
- `backoff` mirrors BullMQ's `{ type: 'fixed' | 'exponential', delay }` shape, so pass-through
  needs no arithmetic — arithmetic is where an off-by-one would hide.

`EnqueueOptions` (`src/runtime/server/drivers/types.ts:10`) gains `attempts?` and `backoff?`,
with the contract documented in the same place and style as `depth()`'s.

### Driver conformance

The three drivers currently disagree, and the disagreement is invisible because the *dev* driver
is the forgiving one — a flaky job retries three times locally and dead-letters on first failure
in production.

| driver | today | after |
| ------ | ----- | ----- |
| `memory` | retried 3× (`MAX_ATTEMPTS`, `memory.ts:9`), immediately, no backoff | honours the job's resolved `attempts`; computes backoff delay into its existing `runAt` (`memory.ts:63`) |
| `bullmq` | **never retried** | passes `attempts`/`backoff` through to `queue.add` |
| `sync` | never retried; errors propagate to the `enqueue` caller | unchanged, documented in the SPI contract |

`sync` keeps not retrying deliberately: its documented purpose is that errors reach the caller so
tests fail loudly (`src/runtime/server/drivers/sync.ts:13`), and retrying would swallow exactly
what it exists to expose. No `retries: boolean` capability flag is added — `DriverCapabilities`
currently feeds the guardrails, and a flag nothing reads is a thing that drifts on its own.

`memory` must match `bullmq` **exactly** on attempt count and delay, pinned by **one shared
conformance table run against both drivers**, not two independent test files. Two files is how
`depth()` drifted.

One fact must be established empirically before the memory driver copies it: **the exact attempt
index BullMQ feeds into the backoff strategy.** The reading above yields `delay` for the first
retry, but `attemptsMade` is mutated across several call sites and a Lua script. If that reading
is off by one, the memory driver copies the error and the two drivers drift on timing — the
precise failure this section exists to prevent. Observe it against real Redis and write the
observed number into the conformance table.

## Testing

**The deliverable is types, and runtime tests cannot see types.** Phase 1's 175 unit tests would
all still pass if the generated map emitted `any` for every job. The primary coverage is
therefore type-level.

### Prerequisite

The decisions record states that `pnpm typecheck` exists but is unwired, carries 12 unfixed
pre-existing errors, and has no CI step — and that this is precisely why a client-typings leak
went unnoticed until late. **A spec whose entire value proposition is type safety cannot ship
behind a typecheck nobody runs.** Task 1 of the implementation plan is: fix the 12 errors, add
`typecheck` and the type-test run to CI. If this is descoped, the rest of the spec is unverified
by construction.

### Type tests

`vitest --typecheck` with `expectTypeOf` and `@ts-expect-error`, in `*.test-d.ts`:

- `enqueue('send-email', { to, subject })` compiles; `enqueue('send-emial', …)` and
  `enqueue('send-email', { to: 1 })` do not
- `ctx.payload` equals `InferOutput<S>`; `enqueue`'s payload parameter equals `InferInput<S>`;
  **and for a transforming schema the two are asserted unequal** — the assertion that catches a
  regression back to enqueueing the transformed output
- the `input` overload wins over the type-argument overload
- `defineJob<P>({ input: s })` is rejected by `input?: never`
- a job with neither type argument nor schema resolves to `unknown` and `enqueue` accepts
  anything — asserted deliberately, so the accepted gap is a recorded decision rather than a
  later discovery

**`@ts-expect-error` is a weak assertion.** It passes if *any* error occurs on that line,
including a typo or syntax error unrelated to the behaviour under test — the type-level twin of
the "assertions that could not fail" pattern that produced eight defects in phase 1. Every
negative case is paired with the corresponding positive case that must compile, so a broken
fixture fails one side or the other instead of silently satisfying both.

### Runtime tests

Each of these needs **both halves**; either alone is satisfied by the broken behaviour.

| case | assertion |
| ---- | --------- |
| producer rejection | the error throws **and** `driver.enqueue` was never called |
| transform-once | the encoded envelope holds the **raw** input **and** `ctx.payload` holds the **output** |
| redaction | given a schema whose message embeds the received value (author it with `superRefine` — do **not** rely on a validator's defaults, see the note under [Error taxonomy](#error-taxonomy)), the consumer-side message **excludes** that value **and includes** the issue path |
| permanent classification | `JobPayloadInvalidError` classifies through the existing `isPermanentFailure` **and** bullmq maps it to `UnrecoverableError` |
| defaults resolution | a per-job value overrides the module default **and** the module default applies when the job omits it |
| async schema | a `validate` returning a promise is awaited on the producer **and** on the consumer |

Plus the shared retry conformance table against `memory` and `bullmq`: succeeds first try; fails
then succeeds; exhausts attempts; permanent failure skips remaining attempts; `attempts: 1` never
retries; delay between retry k and k+1 matches the observed formula.

### Lifecycle scenarios

Real Redis, real built output:

- a job that fails once is retried and completes across a real drain
- ~~an invalid payload dead-letters immediately, with attempts-made of 1 against `attempts: 3`~~
  — **knowingly deferred, not built.** Producer-side validation (`validateOnEnqueue`) makes this
  scenario near-impossible to construct honestly at this layer: the same build's producer schema
  rejects the payload before it is ever enqueued, so triggering the worker-side path requires two
  schemas or two builds (e.g. enqueue against an older/looser schema, then have a newer/stricter
  build's worker reject it) — deliberately out of scope for a single-build lifecycle harness. The
  behaviour IS covered, just not at this layer:
  - `test/unit/drivers/bullmq-mapping.test.ts` — "converts a retryable:false error thrown by a
    registered handler into UnrecoverableError", against the driver's real captured processor.
  - `test/unit/retry-conformance.test.ts` — "stops immediately on a permanent failure, without
    consuming remaining attempts", run against both the memory driver and (when `REDIS_URL` is
    set, as it always is under `pnpm test:lifecycle`) a real `bullmq` driver against real Redis —
    a permanent failure with `attempts: 5` consumes exactly one attempt.

  This requirement is recorded here rather than silently dropped, and its coverage is real rather
  than claimed: both tests above fail if the behaviour they check regresses.

Per the established convention, the scenario that was built must be observed failing against the
broken behaviour before it counts.

### The question to ask of every assertion

The single most repeated defect in phase 1 was assertions that could not fail — eight instances,
two of them introduced by fixes for earlier ones. `eslint-plugin-vitest` catches the syntactic
forms. The semantic ones require asking, of every assertion in this spec: **would this fail if
the behaviour were removed?**

## Breaking changes

Almost nothing breaks at the type level, which is the payoff from keeping the `ctx` handler
signature:

| change | breaking? |
| ------ | --------- |
| handler signature | unchanged — still `(ctx)` |
| `defineJob({ handler })` with no type argument | compiles; payload `unknown` |
| `JobContext` gains a type parameter | defaults to `unknown`; bare `JobContext` still valid |
| `enqueue` on an untyped job | compiles; accepts anything |
| `enqueue` with a wrong payload on a **typed** job | now a compile error — the point of the spec |
| `Supervisor.routes` → registry | internal shape change; `getDriver()` is exported but has no compat promise at alpha |

**The one real behaviour change is retries.** Production goes from effectively one attempt to
three. Combined with at-least-once delivery, this deserves a loud CHANGELOG entry rather than a
footnote: **a non-idempotent handler that previously failed once and stopped will now run its
side effects up to three times.** Anyone implicitly relying on no-retry gets double-charged
cards.

The honest mitigation for now is documentation — "handlers must be idempotent", stated
prominently — because first-class dedup keys are deferred, not in this spec.

### Dependencies and fixtures

- `@standard-schema/spec`, pinned, in `dependencies` (types-only, zero runtime)
- `zod`, pinned, in `devDependencies` for tests and the playground
- `playground/server/jobs/slow.ts` declares a `SlowPayload` interface and reads `payload.seq` /
  `payload.durationMs` directly. The two casts it used to carry
  (`payload as { durationMs?: number }`, `payload as { seq: number }`) are gone — typing the job
  removed the need for them, which is the smallest visible sign the feature works
- README's API section is updated. The docs site is rewritten in spec 4, so changes stay in
  README.

## Deferred

| # | Item | Where it goes |
| - | ---- | ------------- |
| 1 | Cron as a `defineJob` property | Spec 5. Its hard part is schedule reconciliation across a multi-instance deploy, not the `defineJob` key — a lifecycle problem wearing a codegen costume. |
| 2 | Dedup / `unique` / `uniqueId(payload)` | Spec 5, alongside cron. Also the mitigation for the retry behaviour change above. |
| 3 | Lazy handler loading, lean producer bundle | Joins phase 1's deferred `worker: { entry: 'separate' }`. Both are "which code lands in which process's bundle". |
| 4 | Transactional outbox | Its own spec. Needs a transaction boundary the module does not currently know about. |
| 5 | Per-job middleware and a `failed` hook | Unscheduled. |
| 6 | `jitter` on backoff | Exists in BullMQ; withheld until the memory driver has a conformance story for it. |
| 7 | Exposing `lockDuration` | Carried forward unresolved from phase 1. |

**Dropped, not deferred:** AST extraction of `defineJob` metadata. See
[Corrections](#corrections-to-the-phase-1-design-document).
