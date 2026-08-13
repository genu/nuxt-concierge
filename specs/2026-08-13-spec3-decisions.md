# Spec 3 decisions record

Distilled from the spec 3 execution ledger. The design spec says what was intended; this says
what was decided along the way, what was deliberately left undone, and which facts were
expensive to learn.

Read this before starting spec 4 or spec 5. The first section is build-breaking or
silently-behaviour-breaking if violated.

## Constraints that will break the build or silently break behaviour

- **Never use `export * from "<path>"` inside a generated `.d.ts`.** A failing re-export is
  swallowed by `skipLibCheck: true`, so the module declaration is *found* but has zero exported
  members — you get `TS2305: has no exported member`, not a resolution error. Use
  `const x: typeof import("<abs>").x` instead, which is the form `createTemplateInternalTypes`
  and the `#concierge` template both use. Established by experiment after a task stalled on it.

- **Every `#concierge*` alias needs a declaration in BOTH the nitro and app graphs.** Nitro's
  generated `nitro-routes.d.ts` references every server route handler to type `$fetch`, which
  pulls those handlers into the *app* TypeScript program; and the generated job map's own
  `typeof import('<job file>')` pulls every job *module* in as well. A nitro-only declaration
  therefore fails with `TS2307` in the app graph. This is why `types/concierge{,-app}.d.ts`,
  `concierge-jobs{,-app}.d.ts`, `concierge-handlers{,-app}.d.ts` and
  `concierge-internal{,-app}.d.ts` are each emitted twice.

  The accepted cost, recorded so nobody "fixes" it: client code can now `import { useQueue }
  from '#concierge'`, typecheck, and fail later at build time when the client bundler cannot
  resolve the alias. That trade was taken deliberately — breaking correct *server* code (any API
  route that enqueues a job and returns a value) is worse than failing to prevent incorrect
  *client* code, and the client failure is loud rather than silent.

- **Do not reintroduce `defaults:` to `defineNuxtModule`.** `@nuxt/kit` applies it with a deep
  `defu(inlineOptions, nuxtConfigOptions, optionsDefaults)` *before* `setup()` runs. That
  silently merged a user's `worker.queues` into the default map instead of replacing it, so a
  config declaring only `{ mail: 2 }` kept a `default` queue nobody asked for — starting a
  consumer and a Redis connection for it, and letting a job that forgot its `queue:` run there
  instead of tripping the "targets an undeclared queue" boot guard. `resolveModuleOptions` is
  now the single resolution point and must stay that way.

- **`JobDefinition.handler` must stay property-syntax.** Its contravariance is load-bearing: it
  is what makes `driver.registerHandler(q, n, job.handler)` a type error and forces callers
  through `run`, which is where consumer-side validation lives. Switching to method syntax to
  "fix" an assignability complaint restores bivariance and silently permits bypassing
  validation. Collections use `AnyJobDefinition` (`JobDefinition<any, any>`) instead — widening
  the element type, not the variance.

- **`EnqueueInputOf` must `infer` both type parameters.** `JobDefinition<infer In, unknown>`
  looks equivalent and never matches, because parameter contravariance on `handler` makes it
  false for every concrete `Out`. The conditional then falls through to `unknown` for every job
  while the generated map still looks correct — every payload silently unchecked.

- **`JobDefinition.__payloadTypes` is load-bearing despite never being assigned or read.** For a
  job that declares no schema, `In` appears in no member at all, and an interface whose type
  parameters appear in no member is structurally identical for every instantiation — so
  extraction silently yields `unknown`. The phantom exists solely to give both parameters a
  member to be inferred from.

- **The generated job map must qualify `EnqueueInputOf` with its module.** An unresolvable name
  inside a generated `.d.ts` is swallowed by `skipLibCheck`, leaving `ConciergeJobMap[K]` an
  error type and every `enqueue` payload effectively `any`. `buildJobMapDeclaration` takes the
  types-module path as a parameter specifically so a unit test can assert the emitted line
  verbatim, qualifier included, with no wildcard.

- **`validateOnEnqueue` must return `Promise<void>`.** Enqueueing the producer's *validated*
  output double-applies a transform, and the consumer's own schema then rejects its own output —
  a job correct at the call site and permanently dead in the worker. Returning nothing makes the
  regression unrepresentable rather than merely untested.

- **Consumer-side validation must stay inside `defineJob`'s `run` wrapper.** The throw has to
  land inside the driver's own `try`/`catch` so the existing `retryable === false` branches in
  `drivers/bullmq.ts` and `drivers/memory.ts` classify it as permanent. Validating before handing
  the job to the driver loses that classification silently.

- **`attempts` is TOTAL attempts including the first**, matching BullMQ. Never translate between
  "attempts" and "retries" anywhere — that conversion is where an off-by-one hides.

## Corrections to earlier claims

All of these were wrong in the spec 3 design document and are corrected there now.

- **`const Name extends string` on `defineJob` is unnecessary.** Names come from the filesystem
  scan at build time, so codegen emits literal keys and `keyof ConciergeJobMap` is a literal
  union for free. Adopting it would also have foreclosed the explicit `defineJob<Payload>` type
  argument, since TypeScript has no partial type-argument inference.

- **AST extraction of `defineJob` metadata is dropped, not deferred.** Dual-side validation must
  *execute* a schema, and reading source text cannot produce a runnable object.

- **`JobDefinition` does need a phantom field, and two handler fields.** An earlier draft claimed
  both type parameters were recoverable from real members. See the constraints above.

- **"The transform runs exactly once" was ambiguous and is now "is *applied* exactly once".** The
  payload is transformed once — raw in, consumer's output to the handler — but **both sides call
  `~standard.validate`**, so a transform or refinement *function* executes twice with the
  producer's result discarded. **Schema validators must therefore be pure**, and must not mutate
  their input in place (the same object reference is what gets serialized).

- **Zod v4 does not echo received values in enum/literal messages; v3 did.** The redaction
  requirement stands — the threat is user-authored messages and other validators' defaults
  (ArkType emits `must be a string (was 5)`) — but the original justification was wrong, and it
  mattered: a test fixture built on it asserted the absence of a value that was never present,
  making the redaction test unfalsifiable. Fixtures now author their own value-echoing message.

## Known gaps, deliberately carried

Each has a tracked issue.

- **`attempts: 0` silently means one attempt** (`0` is not nullish, so it survives the `??`
  fallback and both drivers then run the job once). Documented in the README, unguarded. (#22)
- **`pnpm test:lifecycle` builds the playground twice**, once per lifecycle file, and grows
  linearly with each new one. A `globalSetup` fixes it. (#21)
- **A transient lifecycle flake** — `app exited early with code 0` during a drain, in an
  unmodified scenario, seen once and not reproduced. Possibly pre-existing. Worth chasing
  because that failure class is what spec 1 exists to prevent. (#23)
- **The dev banner logs the wrong dashboard port** when 3000 is taken. (#24)
- **`TypedQueue`'s generic parameter is named `Map`**, shadowing the global. (#25)
- **`test/unit/module.test.ts` is covered by no typecheck script.** (#26)
- **No lifecycle scenario for an invalid payload dead-lettering with attempts-made of 1.**
  Producer-side validation makes it near-impossible to enqueue a payload the same build's worker
  will reject — it needs two schemas or two builds. Covered at unit level instead; recorded in
  the spec rather than silently dropped.
- **A job declaring neither a type argument nor an `input` schema resolves to `unknown`** in the
  generated map, so `enqueue` accepts anything for it with no diagnostic. Accepted design gap,
  documented. The first real consumer app hit this immediately, which is why the README note
  earns its place.

## Facts that cost real time to establish

- **BullMQ's exponential backoff index is `2 ** (k - 1) * delay`** — the first retry waits exactly
  `delay`. Established by probing real Redis (observed gaps ~226/411/824ms for `delay: 200`), not
  by reading `backoffs.js`, because `attemptsMade` is mutated across several call sites and a Lua
  script. The memory driver copies the observed number.
- **BullMQ's default is `attempts: 0`**, whose retry condition `attemptsMade + 1 < attempts` is
  never true. Since the driver passed no `attempts`, **a failing job was never retried in
  production**, while the `memory` driver used in dev and CI retried it three times. The
  forgiving driver was the one developers saw.
- **`nuxi typecheck` calls `writeTypes()`/`buildNuxt()` before `vue-tsc`**, silently regenerating
  any generated file you deleted. Deleting one to prove it is load-bearing proves nothing;
  disable its emission at source instead.
- **`vitest` does not typecheck.** A runtime spy captures call arguments regardless of a
  TypeScript gap, so "these two tests will be red" can be a mechanically impossible prediction.
  Use `pnpm typecheck` for that gate.
- **CI's `pnpm test` needs `REDIS_URL`.** The retry conformance table's bullmq half is guarded on
  it, so without it the table silently degrades to memory-only in the one place it is automated.
- **`pkg.pr.new` publishes an installable preview per commit** (`pnpm add
  https://pkg.pr.new/nuxt-concierge@<pr>`), which is the fastest way to smoke-test a change in a
  real app before cutting a release.

## Test-suite conventions established

Extending the phase 1 conventions, which still hold.

- **Type-level tests run under `pnpm test:types`** (`vitest --typecheck`, `test/types/**/*.test-d.ts`).
  They are the only coverage that can see the spec's actual deliverable: every runtime test would
  still pass if codegen emitted `any` for every job.
- **`@ts-expect-error` is a weak assertion.** It passes if *any* error occurs on that line,
  including a typo unrelated to the behaviour under test — the type-level twin of an assertion
  that cannot fail. Pair every negative case with the positive case that must compile.
- **The type-test harness guards itself.** `test/types/harness.test-d.ts` carries a negative
  assertion whose removal must break the run; a `--typecheck` run that is silently a no-op looks
  identical to one that passes.
- **Bounds must discriminate, not merely pass.** The exponential conformance case's ceiling on
  the *first* gap is what catches a ±1 backoff index shift. A ratio assertion cannot: a shift
  preserves the ratio exactly (400/200 and 800/400 are both 2).
- **Assert both halves.** "Throws" *and* "the handler never ran"; "the envelope holds the raw
  input" *and* "`ctx.payload` holds the output"; "the message excludes the value" *and*
  "includes the path". Either half alone is satisfied by the broken behaviour.
- **One shared conformance table across drivers**, never two independent files — that is how
  `depth()` drifted in phase 1.

## Process note

Spec 3 ran as 14 tasks (13 dispatches; two were merged because one could not end green alone),
each with an independent review and fix loop. Seven needed one, nine rounds in total, plus one
fix wave after the whole-branch review.

**Every defect found originated in the plan's or the spec's own reference code, not in
execution** — the same finding as phase 1, and worth stating twice because the plan being
detailed did not make it correct. Several would have shipped: a job registry contract no typed
job could satisfy, a redaction test that could not fail, a conformance case whose bounds could
not catch the regression it existed for, and a `defineNuxtModule` option that made a documented
guarantee unreachable.

Two failure shapes recurred and are worth watching for directly:

1. **A test that exists, passes, and proves nothing.** Not only the phase 1 pattern of
   unfalsifiable assertions, but its subtler cousin: a *scenario* silently going missing while
   every assertion in the file survives. Updating three tests to supply an explicit `attempts`
   removed the only coverage of "absent means one attempt" without touching a single assertion.
2. **A justification that is wrong in a way the code hides.** The Zod v4 message change, and the
   `@nuxt/kit` merge ordering, both made a documented guarantee untestable while leaving the
   suite green.

Ask of every assertion: *would this fail if the behaviour were removed?* And of every test
edit: *does this still cover the case it was written for?*
