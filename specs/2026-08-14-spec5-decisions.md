# Spec 5 decisions record

Distilled from the spec 5 execution ledger (14 tasks, each with an independent review and fix
loop). The design spec says what was intended; this says what was decided along the way, what
was deliberately left undone, and which facts were expensive to learn.

Read this, alongside the [phase 1](2026-08-13-phase1-decisions.md), [spec 3](2026-08-13-spec3-decisions.md)
and [spec 4](2026-08-13-spec4-decisions.md) records, before starting anything that touches cron
or deduplication again.

## Constraints that will break the build or silently break behaviour

- **`import { parseExpression } from 'cron-parser'` throws at runtime.** `cron-parser` 4.9.0 is
  CommonJS with no `exports` map, and this package is `type: module` — the named-import form
  throws `SyntaxError: Named export 'parseExpression' not found` the first time `resolveCron` or
  `nextFireTime` actually runs, and no typecheck catches it, because the `.d.ts` shape is
  identical either way. BullMQ's own ESM source uses the named form and gets away with it only
  because Node resolves BullMQ's CJS build, not this package's. `src/runtime/server/cron.ts` uses
  the default-import form (`import cronParser from 'cron-parser'; const { parseExpression } =
  cronParser`) — do not "tidy" it back to a named import.

- **`concierge.cron.enabled` is deployment-wide, not per-instance.** `false` does not skip
  reconciliation — it runs the sweep with an *empty* declared set, so every concierge-owned
  schedule is removed from Redis on that instance's next boot. An instance with it `false` will
  therefore prune the schedules of an instance with it `true`, because neither instance
  coordinates with the other; each just reconciles its own view of "what should exist" against
  Redis. Setting this inconsistently across a fleet — a canary with the old value alongside a
  majority with the new one, say — makes schedules flap in and out of existence until the
  rollout finishes. There is no way to make this safe without adding real coordination, which
  this spec deliberately does not do (see tick-uniqueness below); document it loudly instead,
  which `src/options.ts` and `README.md` both now do.

- **A cron job's ticks are never deduplicated, even when the job declares `unique`, and this is
  a type-level fact, not a missing feature.** BullMQ's `JobSchedulerTemplateOptions` is `Omit<
  JobsOptions, 'jobId' | 'repeat' | 'delay' | 'deduplication' | 'debounce'>` — a scheduler's job
  template cannot carry deduplication options at all, in either driver, because `memory` mirrors
  this exemption rather than being more forgiving. `unique` still applies in full to anything
  enqueued through `useQueue().enqueue`, including a dashboard "Run now" of that same job — only
  ticks the scheduler itself produces are exempt. An earlier draft of the plan that fed this task
  claimed cron plus `unique` gives "no more than one queued job at a time"; that line was wrong
  and was corrected before it reached the shipped README.

- **Seconds-granularity cron expressions work, and this is worth documenting as supported rather
  than leaving as an accident.** `resolveCron` validates by handing the expression straight to
  `cron-parser`'s `parseExpression` with no field-count check of its own, so a 6-field pattern
  (`*/2 * * * * *`) passes through to BullMQ unmodified — verified by direct execution, not
  inferred from either library's docs. Nobody set out to support this; it falls out of the parser
  having no opinion on field count. README now says so explicitly instead of leaving it for
  someone to discover by accident and wonder whether it is safe to rely on.

- **Scheduler-produced jobs silently got no retry policy at all, in both drivers, until this
  task.** This is the single most consequential finding of spec 5's lifecycle pass, and it shipped
  in tasks 3/7/8 without being noticed by any unit test. `reconcileSchedules` (`cron.ts`) built
  each `ScheduleSpec` from only `{ id, jobName, expression, tz, payload }`; neither
  `bullmq.ts`'s `schedule.upsert` (which called `upsertJobScheduler` with a job template of just
  `{ name, data }`, no `opts`) nor `memory.ts`'s `arm()` (which called `driverSelf.enqueue(...)`
  with no `attempts`/`backoff` fields) ever forwarded a job's configured — or defaulted —
  `attempts`/`backoff` into a tick it produced. The practical effect: a cron job that failed on a
  scheduled tick got BullMQ's (or `memory`'s) bare built-in default of a single attempt and no
  backoff, regardless of what `attempts`/`backoff` the job declared or what `concierge.defaults`
  said, and dead-lettered permanently on the very first failure of *every single tick*, forever —
  while a manual `enqueue()` of the identical job, including a dashboard "Run now", retried
  correctly, because that path resolves `attempts`/`backoff` in `useQueue.ts`. No existing unit
  test caught this because every existing retry/attempts test — the retry conformance table
  included — calls `driver.enqueue(...)` directly with explicit `attempts`, never through a
  scheduler tick. `test/lifecycle/cron.test.ts`'s "reports the same tick across a retry of that
  tick" scenario is the first (and, at the time of writing, only) coverage anywhere that fails a
  *scheduler-produced* job and checks it actually retries — it failed with `did not observe 2
  attempt(s) ... within 90000ms` against the as-shipped code, which is how this was found.
  Fixed by resolving `attempts`/`backoff` against `concierge.defaults` inside `reconcileSchedules`
  itself (a new `defaults: JobDefaults` argument) and threading the resolved values through
  `ScheduleSpec.attempts`/`ScheduleSpec.backoff` into both drivers' schedule-production paths.
  `ScheduleSpec.attempts`/`backoff` stayed *optional* on the type, deliberately, so the several
  `planReconciliation` unit tests that hand-build minimal specs (which that pure set-arithmetic
  function never inspects those fields for) did not all need updating — only `reconcileSchedules`
  itself, which is the one place required to always fill them in for a schedule that will
  actually reach a driver.

## Corrections to earlier claims

- **`Queue.getDeduplicationJobId` does exist in bullmq 5.63.0** — declared on `QueueGetters`,
  which `Queue` extends. An earlier round of spec 5 asserted it did not, having grepped
  `classes/queue.d.ts` alone rather than its base class, and shipped a hand-rolled key read before
  review caught it (`7f2caf3`, `d67193a`). Recorded again here because it is the one place in this
  spec where "verified against the installed source" meant grep rather than execution, and it was
  the one claim that turned out wrong. Every other "verified" claim in this spec and its
  predecessor's decisions records was checked by actually running the code.

- **The default dedup key is a hash of the serialized envelope, not an order-insensitive canonical
  form** — and this was a deliberate reversal partway through the spec, not the original design.
  An order-insensitive canonical form was specified and attempted across three implementation
  rounds; each round fixed the cited examples while leaving the mechanism itself open, because a
  hand-written canonical form dispatches on `instanceof`/prototype identity while `devalue`
  dispatches on `Object.prototype.toString`'s brand and on shape, and any value sitting in the gap
  between those two dispatchers got `devalue`'s raw insertion-ordered walk regardless of which
  canonicalization was attempted. Escapees found in review before the reversal: a `URL` subclass
  carrying its own extra property (two different hrefs, one dedup key — a silently *suppressed*
  job), data inherited one link up a null-prototype chain, and cross-realm `Map`/`Set`. Hashing the
  exact stored envelope has exactly one dispatcher, so that class of gap cannot exist by
  construction — at the accepted cost that object key order, Map/Set insertion order, reference
  identity of equal sub-objects, and `Object.create(null)` vs `{}` now all affect the key. That
  trade is documented in `dedup.ts`, in the README's Deduplication section, and repeated here
  because it is the single most consequential design reversal in this spec: order sensitivity
  means an occasional extra run, which every handler must already tolerate under at-least-once
  delivery, whereas the alternative meant a job that should have run did not, silently.
  `uniqueId` is the escape hatch for a payload assembled from more than one call site.

## Known gaps carried forward, with their status

- **The `memory` driver's debounce `replace` only supersedes a job still in `pending`** (waiting
  or delayed) — a job already claimed by the run loop (`active`) is not replaced, matching
  BullMQ's own `removeDelayedJob` returning `false` for a job no longer in a removable list.
  Confirmed **by reading `memory.ts`'s dedup branch in `enqueue()`** (the `idx = q.findIndex(...)`
  guard: a job the poll loop has already spliced out of the pending array cannot match, and the
  fall-through comment says so), matching the same claim already made in `memory.ts`'s own
  comments. **Not independently exercised by an automated test** — every existing debounce test
  (`cron-dedup-conformance.test.ts`, `memory-dedup.test.ts`) covers the *pending* case (the one
  that discriminates `replace` from throttle) but none deliberately let the target job go active
  first and then re-enqueue against it. Recorded here rather than silently, as the brief asked:
  confirmed true by code reading, not by a dedicated test. Worth a follow-up unit test, but out of
  this task's scope to add.

- **BullMQ's `deduplicated` flag is best-effort under concurrency, by construction, and stays
  that way.** The read and the add are two separate round trips in `bullmq`'s own
  `getDeduplicationJobId`/`add` pair, so two callers racing on the same key can both observe an
  empty key, and the loser reports `deduplicated: false` for an enqueue that was in fact
  suppressed. One-directional only: a fresh enqueue can never be *mis*-reported as deduplicated,
  because BullMQ's job ids are monotonic per queue. The deduplication itself stays atomic in
  BullMQ's Lua regardless — this only affects the caller-facing *report*. Documented on
  `EnqueueResult.deduplicated`; the conformance table asserts the resulting job **count**, never
  this flag, for the case that would otherwise be racy to assert on.

## Test-suite conventions this spec added or leaned on

- **A lifecycle scenario counts only once it has been watched failing against the behaviour it
  guards.** Verified for `test/lifecycle/cron.test.ts`'s "prunes a schedule that is no longer
  declared" case: `reconcileSchedules`'s removal loop was commented out, the single scenario was
  re-run in isolation (`vitest run ... -t "prunes a schedule"`), and it failed with `expected [
  'concierge:deleted-job', ... ] to not include 'concierge:deleted-job'` — then the removal loop
  was restored and the full file re-run green. This is the same phase-1 convention repeated: a
  scenario nobody has watched fail is not evidence, it is an assumption wearing a test's clothes.

- **Real cron granularity makes `test/lifecycle/cron.test.ts` slow, and that is inherent, not a
  bug in the harness.** The playground fixture (`heartbeat-digest`) is intentionally `* * * * *`
  — every minute — "so a dev session or a lifecycle run actually sees it fire" (its own comment).
  The two-worker "bounded runs per tick" scenario genuinely waits on up to two real minute
  boundaries (worst case a little over two wall-clock minutes), and the retry-tick scenario waits
  on up to one. The whole file's observed run time is 174-245 seconds depending on where in the
  minute it happens to start. This is real time passing, not a fixed sleep the harness convention
  otherwise forbids — there is no faster way to prove a real BullMQ Job Scheduler fires a real
  tick on a real cron pattern. Each scenario's own `it(..., timeoutMs)` is set generously above the
  worst case for exactly this reason (up to 220s for the two-tick case).

- **`REDIS_URL` is required for the cron and dedup conformance table, and its bullmq half silently
  degrades to skipped without it** — carried forward from spec 3/4's identical convention for the
  retry conformance table, and true again here for the exact same shared-driver-loop reason.
  `pnpm test` and `pnpm test:lifecycle` must both run with `REDIS_URL` set for this to mean
  anything; CI already does.

- **Readiness is a health-endpoint poll, and duplicates are counted and bounded, never asserted
  zero** — both existing phase-1 conventions, both reused as-is by `cron.test.ts`'s own new
  helpers (`waitForReady` unchanged; `countRunsOverTicks` bounds `[2, 3]` rather than asserting
  exactly `2`, for the same at-least-once reason every other duplicate-count assertion in this
  project does).

## Other facts that cost real time

- **The chrome-devtools MCP server in this environment could not complete a browser connection**
  (`Target.setDiscoverTargets timed out`), reproducibly, across a killed-and-restarted Chrome
  profile and a fully clean process state. The `browse` skill's own headless Chromium (a separate
  binary, not the MCP server) connected on the first try and was used instead to drive the actual
  verification of the Schedules panel — see the task report for the screenshots and the exact
  interaction sequence. If this MCP server is relied on for a future task's browser verification,
  budget time for it to simply not work and have a fallback ready.

- **The task brief's own suggested CI assertion (`npm pack --dry-run | grep -q dist/client`) is
  the weaker pattern spec 4 already rejected, on the record, in `ci.yml`'s own comments** —
  `--dry-run` still runs `prepack` and vite's build step unconditionally logs
  `../dist/client/index.html ...` to stdout the moment `build:client` runs, even under the
  dangerous build order that lets `nuxt-module-build build`'s `clean: true` wipe it back out
  moments later — so grepping combined stdout for that text cannot fail even when `dist/client`
  is genuinely empty at pack time, confirmed by deliberately reintroducing the dangerous order in
  spec 4 and watching the grep stay green regardless. `ci.yml` already runs a real `npm pack`
  followed by `tar -tzf ... | grep -q 'package/dist/client/'` against the actual archive contents,
  which does not have this blind spot, and was left unchanged rather than downgraded to match the
  brief's suggested one-liner. The one-liner was still run locally, as this task's own rules
  required, purely as a sanity check — see the task report.
