# Spec 5 — Cron and deduplication: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring cron back as a property of `defineJob`, reconciled across a multi-instance deploy
by idempotent upsert plus mark-and-sweep pruning, and add three deduplication modes mapped onto
BullMQ's verified primitives — with full `memory` driver parity for both.

**Architecture:** A `DriverScheduling` sub-object is added to `ConciergeDriver` as an optional
property, where presence *is* the capability — the same shape spec 4 gave `introspect`. `bullmq`
implements it over job schedulers, `memory` over `cron-parser` plus in-process timers, `sync` not
at all. Reconciliation runs once at boot on any non-`web` instance: upsert every declared schedule
for each declared queue, then remove every concierge-owned scheduler on that queue that is not
declared. Deduplication passes a `DeduplicationOptions` shape straight through to BullMQ with no
translation layer, and `memory` reimplements the same three behaviours against the same
conformance table.

**Tech Stack:** Nuxt 4 module (`@nuxt/kit`), Nitro/h3, BullMQ 5.63.0 + ioredis, `cron-parser`
4.9.0, `devalue`, Vitest; and for the SPA, Vite + Vue 3 + `@nuxt/ui` v4.

**Spec:** [`specs/2026-08-14-concierge-v2-spec5-cron-dedup.md`](../2026-08-14-concierge-v2-spec5-cron-dedup.md)

**Prerequisite reading, not optional:** [phase 1 decisions](../2026-08-13-phase1-decisions.md),
[spec 3 decisions](../2026-08-13-spec3-decisions.md) and
[spec 4 decisions](../2026-08-13-spec4-decisions.md). The first section of each is build-breaking
or silently behaviour-breaking.

## Global Constraints

- **`import { parseExpression } from 'cron-parser'` THROWS AT RUNTIME.** cron-parser 4.9.0 is
  CommonJS with no `exports` map and no named exports the ESM loader can detect, and this package
  is `type: module`. Verified by direct execution: `SyntaxError: Named export 'parseExpression' not
  found`. **Always** `import cronParser from 'cron-parser'` and destructure. BullMQ's own ESM
  source uses the named form and gets away with it only because Node resolves BullMQ's CJS build;
  do not copy it.
- **`attempts` is TOTAL attempts including the first**, matching BullMQ. Never translate between
  "attempts" and "retries" anywhere.
- **Pin every dependency exactly.** No `^` or `~` ranges, in any `package.json` in this repo.
- **`cron-parser` is pinned to `4.9.0`** — the version BullMQ already resolves — so both parse
  expressions with one copy of one library. A second cron implementation is a conformance
  divergence waiting to happen; `croner` is present via Nitro and must not be used.
- **Never use `export * from "<path>"` inside a generated `.d.ts`.** Use
  `const x: typeof import("<abs>").x`.
- **Every `#concierge*` alias needs a declaration in BOTH the nitro and app graphs.** This plan
  adds no new aliases; do not remove existing paired declarations.
- **Do not add `defaults:` to `defineNuxtModule`.** `resolveModuleOptions` is the single
  resolution point.
- **`JobDefinition.handler` stays property-syntax.** Its contravariance is what forces callers
  through `run`. Collections use `AnyJobDefinition`.
- **Dashboard registration is gated on `nuxt.options.dev` at build time**, never a runtime flag.
- **`build:client` runs LAST in `prepack` and `dev:prepare`.** Never first — unbuild's
  `clean: true` deletes `dist/` wholesale, and the failure is a silent empty directory in the
  tarball.
- **Every new driver read goes through `withTimeoutOrThrow`.** A dead-Redis command never rejects;
  it never settles at all.
- **Payload content never reaches an error message.** Shape only.
- **Assertions must be able to fail.** Ask of every one: *would this fail if the behaviour were
  removed?* Bounds must discriminate, not merely pass.
- Node `>=22`, pnpm `10.34.5`, `type: module`, ESM only. Conventional Commits.

---

## File Structure

**Created:**

| File | Responsibility |
| ---- | -------------- |
| `src/runtime/server/dedup.ts` | Dedup-key derivation from the serialized envelope. Pure. |
| `src/runtime/server/cron.ts` | Schedule resolution, reconciliation planning, boot payload validation. Pure. |
| `src/runtime/server/routes/api/schedules-list.ts` | `GET /_concierge/api/schedules` |
| `src/runtime/server/routes/api/schedules-run.ts` | `POST /_concierge/api/schedules/:name/run` |
| `client/src/panels/SchedulesPanel.vue` | The Schedules panel |
| `test/unit/dedup.test.ts` | Default key derivation from the serialized envelope |
| `test/unit/cron.test.ts` | Reconciliation planning, schedule resolution, boot validation |
| `test/unit/drivers/memory-dedup.test.ts` | `memory` dedup internals |
| `test/unit/drivers/memory-schedule.test.ts` | `memory` scheduling internals |
| `test/unit/drivers/bullmq-schedule.test.ts` | `bullmq` scheduler mapping, pure parts |
| `test/unit/cron-dedup-conformance.test.ts` | One shared table over every driver declaring `schedule` / dedup |
| `test/unit/api/schedules.test.ts` | Both new routes |
| `test/lifecycle/cron.test.ts` | Two workers, one scheduler, one run per tick |

**Modified:**

| File | Change |
| ---- | ------ |
| `src/options.ts` | `CronOptions`, `cron` on both option types, `moduleDefaults.cron` |
| `src/runtime/server/types.ts` | `JobContext.cron`, `CronSpec`, `UniqueOptions`, `JobDefinition` fields |
| `src/runtime/server/drivers/types.ts` | `DriverScheduling`, `ScheduleSpec`, `ScheduleSummary`, `EnqueueOptions.dedup`, `EnqueueResult`, `JobDetail.deduplicationId` |
| `src/runtime/server/drivers/sync.ts` | New `enqueue` return; declines `schedule` |
| `src/runtime/server/drivers/memory.ts` | Dedup state, scheduling, `ctx.cron` |
| `src/runtime/server/drivers/bullmq.ts` | Dedup pass-through, scheduling, `ctx.cron` extraction |
| `src/runtime/server/handlers/defineJob.ts` | `cron`, `unique`, `uniqueId` |
| `src/runtime/server/supervisor.ts` | `RegistryEntry` fields, boot reconciliation, boot validation |
| `src/runtime/server/utils/useQueue.ts` | Dedup resolution, `{ id, deduplicated }` |
| `src/runtime/server/introspect.ts` | `schedulable`, `readSchedules` |
| `src/module.ts` | Two new dev-only route registrations |
| `client/src/api.ts`, `types.ts`, `App.vue` | Schedules tab and its client |
| `package.json` | `cron-parser` dependency |
| `README.md` | Cron and dedup docs, including the two honesty statements |

---

## Task 1: Types, config, and `sync` declining both features

**Files:**
- Modify: `src/options.ts`
- Modify: `src/runtime/server/types.ts`
- Modify: `src/runtime/server/drivers/types.ts`
- Modify: `src/runtime/server/drivers/sync.ts:44-53`
- Modify: `src/runtime/server/drivers/memory.ts:326-340`
- Modify: `src/runtime/server/drivers/bullmq.ts:285-299`
- Test: `test/unit/cron-dedup-conformance.test.ts` (created here, grown in Task 9)
- Test: `test/unit/options.test.ts`

**Interfaces:**
- Produces: `CronOptions`, `CronSpec`, `UniqueOptions`, `JobContext.cron`, `ScheduleSpec`,
  `ScheduleSummary`, `DriverScheduling`, `ConciergeDriver.schedule?`, `EnqueueOptions.dedup`,
  `EnqueueResult`, `JobDetail.deduplicationId?`.
- Consumes: nothing.

No driver implements `schedule` yet and no driver deduplicates yet. This task ends green because
the only behavioural assertions are that `sync` declines scheduling, that every driver's `enqueue`
now returns `deduplicated: false`, and that `cron.enabled` defaults to `true`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cron-dedup-conformance.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createSyncDriver } from '../../src/runtime/server/drivers/sync'
import { createMemoryDriver } from '../../src/runtime/server/drivers/memory'

/**
 * `sync`'s contract is ABSENCE, which is a stronger and different claim than
 * "calling it fails". A uniform interface whose sync implementation silently
 * no-ops would make "this driver cannot schedule" indistinguishable from
 * "there are no schedules", and the Schedules panel would render a confident
 * empty table that is a lie. Asserting the type-level fact at runtime means a
 * later "helpful" stub breaks this test rather than quietly changing what the
 * dashboard claims.
 */
describe('sync driver scheduling', () => {
  it('declares no scheduling at all', () => {
    expect(createSyncDriver().schedule).toBeUndefined()
  })
})

describe('enqueue result shape', () => {
  it('reports deduplicated:false when no dedup was requested — sync', async () => {
    const driver = createSyncDriver()
    driver.registerHandler('default', 'noop', async () => {})
    const result = await driver.enqueue('default', { name: 'noop', payload: {} })
    expect(result.deduplicated).toBe(false)
    expect(result.id).toEqual(expect.any(String))
  })

  it('reports deduplicated:false when no dedup was requested — memory', async () => {
    const driver = createMemoryDriver()
    const result = await driver.enqueue('default', { name: 'noop', payload: {} })
    expect(result.deduplicated).toBe(false)
    expect(result.id).toEqual(expect.any(String))
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/cron-dedup-conformance.test.ts`

Expected: FAIL. `deduplicated` is `undefined` on both drivers, so both `toBe(false)` assertions
fail with `expected undefined to be false`. The `schedule` case passes already (reading an
undeclared property yields `undefined`) — that is fine; it is a regression guard, and Step 3 makes
it a *typed* one.

- [ ] **Step 3: Add the driver SPI types**

In `src/runtime/server/drivers/types.ts`, add above `ConciergeDriver`:

```ts
/**
 * Mirrors BullMQ's `DeduplicationOptions` field-for-field and deliberately, so
 * the bullmq driver passes it straight through. Any translation layer here is
 * a place for a semantic drift to hide — the same reasoning that keeps
 * `BackoffOptions` shaped like BullMQ's own.
 *
 * The three shapes that matter, verified against
 * `bullmq/dist/esm/scripts/moveToFinished-14.js` in 5.63.0:
 *
 * - `{ id }`            LOCK. No expiry; the key is deleted when the job moves
 *                       to completed OR terminally failed, so it spans queued
 *                       and executing. An INTERMEDIATE failure does not release
 *                       it (retries go through moveToDelayed, not moveToFinished).
 * - `{ id, ttl }`       THROTTLE. On finalization `PTTL` is positive, so neither
 *                       delete branch fires and the key survives to expiry.
 * - `{ id, ttl, extend, replace }`
 *                       DEBOUNCE. `extend` re-arms the TTL on each suppressed
 *                       enqueue; `replace` supersedes the pending delayed job.
 */
export interface DedupOptions {
  id: string
  ttl?: number
  extend?: boolean
  replace?: boolean
}

export interface EnqueueResult {
  id: string
  /**
   * True when this call was SUPPRESSED and `id` refers to the pre-existing
   * job rather than a new one.
   *
   * BullMQ hands back the existing id with no signal at all, which is the part
   * deliberately not copied: silent deduplication turns "why didn't my job
   * run?" into a debugging session. `sync` always reports `false` — it
   * executes inline and does not deduplicate, exactly as it does not retry.
   */
  deduplicated: boolean
}

/** What a driver is asked to install. Resolved; never the user's shorthand. */
export interface ScheduleSpec {
  /** `concierge:<jobName>`. Namespaced so the sweep can ignore foreign schedulers. */
  id: string
  jobName: string
  expression: string
  /** IANA zone. Always present — resolution defaults it to UTC, never system-local. */
  tz: string
  payload?: unknown
}

export interface ScheduleSummary {
  id: string
  jobName: string
  queue: string
  expression: string
  tz: string
  /** Next fire time, when the driver knows it. */
  next?: number
  /**
   * Ticks produced so far, when the driver tracks it.
   *
   * There is deliberately no `last` field. `JobSchedulerJson` (bullmq 5.63.0)
   * exposes no previous-fire time — `RepeatOptions.prevMillis` is marked
   * internal and is not returned — and deriving one from the most recent
   * produced job is an extra read per row whose only purpose is to make a
   * column look complete.
   */
  iterationCount?: number
}

/**
 * Presence IS the capability, exactly as with `introspect`. A driver either
 * schedules or does not, as a type-level fact. Boolean flags alongside optional
 * methods permit a driver declaring support it lacks, and typecheck fine.
 *
 * TICK-UNIQUENESS IS A DRIVER RESPONSIBILITY, NOT THE SUPERVISOR'S. Every
 * instance reconciles at boot with no coordination, because `bullmq` guarantees
 * one delayed job in flight per scheduler atomically in Lua and `memory` is
 * single-process. A driver with neither property would double-fire every
 * schedule on every instance, silently. This comment is the only warning its
 * author will get.
 */
export interface DriverScheduling {
  /** Idempotent by `spec.id`. A changed expression updates in place. */
  upsert: (queue: string, spec: ScheduleSpec) => Promise<void>
  list: (queue: string) => Promise<ScheduleSummary[]>
  remove: (queue: string, id: string) => Promise<void>
}
```

Extend `EnqueueOptions` with the dedup field, change the `enqueue` return type, and add the
optional `schedule` property plus `JobDetail.deduplicationId`:

```ts
// inside EnqueueOptions, after `backoff`:
  /**
   * Resolved by `useQueue` from the job's own `unique`/`uniqueId`, never by a
   * driver. Absent means "do not deduplicate this enqueue".
   */
  dedup?: DedupOptions

// inside JobDetail, after `raw`:
  /**
   * First-class rather than a `raw` entry, because the shared conformance
   * table asserts on it and `raw` is documented as driver-specific,
   * display-only, and branched on by nothing. If a test asserts it, it does
   * not belong in the escape hatch.
   */
  deduplicationId?: string

// inside ConciergeDriver, after `introspect`:
  readonly schedule?: DriverScheduling

// and change the enqueue signature:
  enqueue: (queue: string, job: EnqueueOptions) => Promise<EnqueueResult>
```

- [ ] **Step 4: Add the job-level types**

In `src/runtime/server/types.ts`, add `CronSpec` and `UniqueOptions` above `JobContext`:

```ts
/**
 * A schedule, fully resolved. `tz` is always present because resolution
 * defaults it to UTC — never system-local, since a laptop and a container
 * disagree and that disagreement surfaces as "the nightly job ran at the wrong
 * hour in production only".
 */
export interface CronSpec {
  expression: string
  tz: string
  payload?: unknown
}

/**
 * Resolved deduplication policy. `unique: true` resolves to `{}` (lock mode);
 * a TTL makes it a throttle; a TTL plus `debounce` makes it a debounce.
 */
export interface UniqueOptions {
  /** Milliseconds. Absent means lock-until-finalized rather than a window. */
  ttl?: number
  /** Requires `ttl`. Coalesces a burst into one run after the quiet period. */
  debounce?: boolean
}
```

Add `cron` to `JobContext`:

```ts
  /**
   * Present only for a job produced by a schedule.
   *
   * `tick` is the SCHEDULED fire time, not the time the handler started — they
   * differ by queue latency, and only the scheduled time is stable across a
   * retry of the same tick. That stability is the entire point: it gives a
   * handler a natural idempotency key for the at-least-once guarantee.
   */
  cron?: { tick: number, expression: string, tz: string }
```

And add the two resolved fields to `JobDefinition`, after `backoff`:

```ts
  /** Resolved from the string shorthand or the object form. */
  cron?: CronSpec
  /** Resolved: `true` becomes `{}`. Absent means no deduplication. */
  unique?: UniqueOptions
  /**
   * Producer-side. Must be PURE — an impure key does not fail loudly, it just
   * stops deduplicating. Receives the ENQUEUE-side payload (schema input),
   * because it runs before any transform.
   */
  uniqueId?: (payload: never) => string
```

> `uniqueId` is declared with a `never` parameter for the same reason `handler`
> is property-syntax: it must accept every instantiation contravariantly in the
> collection type `AnyJobDefinition` without widening to a bivariant method.

- [ ] **Step 5: Add the config option**

In `src/options.ts`, add the interface above `JobDefaults`:

```ts
export interface CronOptions {
  /**
   * Master switch for every declared schedule.
   *
   * `false` does not skip reconciliation — it runs it with an EMPTY declared
   * set, so the sweep removes every concierge-owned schedule on every declared
   * queue and upserts none. "Off" has to mean off in Redis, not merely off in
   * this process: skipping reconciliation entirely would leave stale schedulers
   * live, producing jobs against a deployment that believes cron is disabled.
   *
   * This is a DEPLOYMENT-WIDE switch, not a per-instance one. An instance with
   * it `false` will prune the schedules of an instance with it `true`, because
   * neither knows about the other. Setting it inconsistently across a fleet
   * makes schedules flap.
   */
  enabled: boolean
}
```

Add `cron?: Partial<CronOptions>` to `ModuleOptions`, `cron: CronOptions` to
`ResolvedConciergeOptions`, and `cron: { enabled: true }` to `moduleDefaults`. No change to
`resolveModuleOptions`' body is needed — `defu` fills it, and unlike `worker.queues` there is no
map to replace.

- [ ] **Step 6: Update all three drivers' `enqueue` returns**

`sync.ts`, replace the final `return { id }` in `enqueue` with:

```ts
      // `sync` never deduplicates, for the same reason it never retries: it
      // executes inline so errors reach the enqueue caller, and silently not
      // running is precisely what this driver exists to prevent. `job.dedup`
      // is ignored rather than honoured.
      return { id, deduplicated: false }
```

`memory.ts`, the same change to its `enqueue` return; `bullmq.ts`, change
`return { id: String(added.id) }` to `return { id: String(added.id), deduplicated: false }`.

- [ ] **Step 7: Add the options test**

Append to `test/unit/options.test.ts`:

```ts
describe('cron options', () => {
  it('defaults cron.enabled to true', () => {
    expect(resolveModuleOptions({}).cron.enabled).toBe(true)
  })

  it('lets a user disable cron without restating other config', () => {
    const resolved = resolveModuleOptions({ cron: { enabled: false } })
    expect(resolved.cron.enabled).toBe(false)
    // Asserted alongside, because a `cron` key that silently replaced rather
    // than merged would be the `worker.queues` defect in a new location.
    expect(resolved.defaults.attempts).toBe(3)
  })
})
```

- [ ] **Step 8: Run the tests and the typecheck**

Run: `pnpm vitest run test/unit/cron-dedup-conformance.test.ts test/unit/options.test.ts`
Expected: PASS.

Run: `pnpm typecheck:tests && pnpm typecheck:public`
Expected: PASS. Any call site still expecting `enqueue` to return exactly `{ id }` surfaces here.

- [ ] **Step 9: Commit**

```bash
git add src/options.ts src/runtime/server/types.ts src/runtime/server/drivers/ \
  test/unit/cron-dedup-conformance.test.ts test/unit/options.test.ts
git commit -m "feat(spec5): scheduling SPI, dedup types and cron config"
```

---
## Task 2: The default dedup key

**Files:**
- Create: `src/runtime/server/dedup.ts`
- Test: `test/unit/dedup.test.ts`

**Interfaces:**
- Consumes: `UniqueOptions` from `runtime/server/types.ts`, `DedupOptions` from `drivers/types.ts`,
  `encodePayload` from `runtime/server/envelope.ts`.
- Produces: `defaultDedupId(jobName: string, payload: unknown): string`,
  `resolveDedup(args: { jobName, payload, unique?, uniqueId? }): DedupOptions | undefined`.

**This task replaces an abandoned design. Read this before writing code.**

An earlier version of this task built an order-insensitive canonical form — recursive key sorting
plus a hand-written encoding per exotic type — so that `{a: 1, b: 2}` and `{b: 2, a: 1}` would share
a dedup key. It was implemented and reviewed three times, and each round closed the cited examples
while leaving the mechanism open. The failure is structural: a hand-written canonical form
dispatches on `instanceof` and prototype identity, `devalue` dispatches on the
`Object.prototype.toString` brand and on shape, and **any value in the gap between those two
dispatchers gets devalue's insertion-ordered walk regardless**. Escapees found in review included a
`URL` subclass carrying its own property (two different hrefs, one key — a silently suppressed job),
objects whose data is inherited one link up a null-prototype chain, and cross-realm `Map`/`Set`.

The replacement hashes the **serialized envelope** — the exact devalue string the driver is about to
store. One dispatcher, so the gap cannot exist. Do not reintroduce a canonical form, a key sort, or
a per-type encoding; the spec now records order sensitivity as an accepted, tested property.

- [ ] **Step 1: Write the failing test**

Create `test/unit/dedup.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { defaultDedupId, resolveDedup } from '../../src/runtime/server/dedup'

describe('defaultDedupId', () => {
  it('is stable for an equal payload', () => {
    expect(defaultDedupId('mail', { a: 1, b: 2 })).toBe(defaultDedupId('mail', { a: 1, b: 2 }))
  })

  it('differs for a different payload', () => {
    // Paired with the case above deliberately: a function returning a constant
    // satisfies "stable for an equal payload" perfectly.
    expect(defaultDedupId('mail', { a: 1 })).not.toBe(defaultDedupId('mail', { a: 2 }))
  })

  it('includes the job name, so two jobs with equal payloads do not collide', () => {
    expect(defaultDedupId('mail', { id: 1 })).not.toBe(defaultDedupId('report', { id: 1 }))
  })

  it('IS sensitive to object key order — an accepted, deliberate property', () => {
    // Not a bug and not an oversight. The order-insensitive canonical form this
    // replaced was attempted three times and abandoned; see the spec's "The
    // dedup key" section. This test exists so the property cannot be silently
    // "fixed" back into the design that failed. A caller who needs
    // order-insensitivity supplies `uniqueId`.
    expect(defaultDedupId('mail', { a: 1, b: 2 })).not.toBe(defaultDedupId('mail', { b: 2, a: 1 }))
  })

  it('distinguishes a value from its string form', () => {
    expect(defaultDedupId('j', { a: 1 })).not.toBe(defaultDedupId('j', { a: '1' }))
  })

  it('distinguishes null from undefined', () => {
    expect(defaultDedupId('j', { a: null })).not.toBe(defaultDedupId('j', { a: undefined }))
  })

  it('distinguishes two different Dates', () => {
    const d = new Date('2026-08-14T00:00:00.000Z')
    expect(defaultDedupId('j', d)).toBe(defaultDedupId('j', new Date(d.getTime())))
    expect(defaultDedupId('j', d)).not.toBe(defaultDedupId('j', new Date(d.getTime() + 1)))
  })

  it('distinguishes two different RegExps', () => {
    expect(defaultDedupId('j', /abc/)).not.toBe(defaultDedupId('j', /xyz/))
    expect(defaultDedupId('j', /abc/g)).not.toBe(defaultDedupId('j', /abc/i))
  })

  it('distinguishes two different URLs', () => {
    expect(defaultDedupId('j', new URL('http://a.example.com')))
      .not.toBe(defaultDedupId('j', new URL('http://b.example.com')))
  })

  it('distinguishes a URL subclass carrying its own property, by href', () => {
    // THE regression that killed the canonical form. Under the sorted-entries
    // design both of these collapsed to one key — two different webhooks, one
    // silently suppressed. devalue serializes a URL subclass by href, so the
    // envelope distinguishes them for free.
    class Webhook extends URL {
      readonly retries: number
      constructor(url: string, retries: number) {
        super(url)
        this.retries = retries
      }
    }
    expect(defaultDedupId('j', new Webhook('http://a.example.com', 3)))
      .not.toBe(defaultDedupId('j', new Webhook('http://b.example.com', 3)))
  })

  it('distinguishes Map contents and Set members', () => {
    expect(defaultDedupId('j', new Map([['x', 1]]))).not.toBe(defaultDedupId('j', new Map([['x', 2]])))
    expect(defaultDedupId('j', new Set([1]))).not.toBe(defaultDedupId('j', new Set([2])))
  })

  it('preserves array order, which is semantic', () => {
    expect(defaultDedupId('j', [1, 2])).not.toBe(defaultDedupId('j', [2, 1]))
  })

  it('is stable for a cron job with no payload', () => {
    expect(defaultDedupId('digest', undefined)).toBe(defaultDedupId('digest', undefined))
  })
})

describe('resolveDedup', () => {
  it('returns undefined when the job declares no uniqueness', () => {
    expect(resolveDedup({ jobName: 'mail', payload: {} })).toBeUndefined()
  })

  it('lock mode carries an id and no ttl', () => {
    expect(resolveDedup({ jobName: 'mail', payload: { a: 1 }, unique: {} }))
      .toEqual({ id: expect.any(String) })
  })

  it('throttle mode carries the ttl and neither extend nor replace', () => {
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: 60_000 } }))
      .toEqual({ id: expect.any(String), ttl: 60_000 })
  })

  it('debounce mode sets extend and replace alongside the ttl', () => {
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { ttl: 5_000, debounce: true } }))
      .toEqual({ id: expect.any(String), ttl: 5_000, extend: true, replace: true })
  })

  it('ignores debounce without a ttl', () => {
    // `extend`/`replace` with no expiry is BullMQ's replace-with-no-expiry
    // branch — a lock that keeps moving, not a debounce window. `defineJob`
    // rejects this combination at definition time (Task 4), so this asserts the
    // resolver degrades safely rather than emitting a mode nobody asked for.
    expect(resolveDedup({ jobName: 'mail', payload: {}, unique: { debounce: true } }))
      .toEqual({ id: expect.any(String) })
  })

  it('prefers a user-supplied uniqueId over the default', () => {
    expect(resolveDedup({
      jobName: 'mail',
      payload: { id: 7 },
      unique: {},
      uniqueId: (p: { id: number }) => `invoice:${p.id}`,
    })?.id).toBe('mail:invoice:7')
  })

  it('namespaces a user-supplied uniqueId by job name', () => {
    // Two jobs whose uniqueId functions both return "1" must not collide — a
    // cross-job interaction nobody could predict from reading either job.
    const a = resolveDedup({ jobName: 'mail', payload: {}, unique: {}, uniqueId: () => '1' })
    const b = resolveDedup({ jobName: 'report', payload: {}, unique: {}, uniqueId: () => '1' })
    expect(a?.id).not.toBe(b?.id)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/dedup.test.ts`

Expected: FAIL with `Cannot find module '.../dedup'`.

- [ ] **Step 3: Implement**

Create `src/runtime/server/dedup.ts`:

```ts
import { createHash } from 'node:crypto'
import { encodePayload } from './envelope'
import type { UniqueOptions } from './types'
import type { DedupOptions } from './drivers/types'

/**
 * Job name plus a hash of the SERIALIZED ENVELOPE — the exact devalue string
 * the driver is about to store.
 *
 * Deliberately not an order-insensitive canonical form. One was specified and
 * attempted across three implementation rounds, and each round fixed the cited
 * examples while leaving the mechanism open. The failure is structural: a
 * hand-written canonical form dispatches on `instanceof` and prototype
 * identity, devalue dispatches on the `Object.prototype.toString` brand and on
 * shape, and any value in the gap between those two dispatchers gets devalue's
 * insertion-ordered walk regardless. Escapees found in review: a `URL` subclass
 * carrying its own property (two hrefs, one key — a silently suppressed job),
 * objects whose data is inherited one link up a null-prototype chain, and
 * cross-realm `Map`/`Set`.
 *
 * Hashing the envelope has ONE dispatcher, so the gap cannot exist by
 * construction, and every exotic type devalue supports is distinguished by
 * value for free.
 *
 * The accepted cost: object key order affects the key, so two call sites
 * building the same logical payload in different orders will not deduplicate
 * against each other. That is the better failure — order sensitivity means
 * deduplication is less effective and the job runs twice, which every handler
 * must already tolerate under at-least-once delivery, whereas the bugs it
 * replaces meant a job was silently suppressed and never ran. `uniqueId` is the
 * escape hatch for payloads assembled from more than one call site.
 *
 * Hashed rather than embedded whole because the id becomes a Redis key suffix,
 * and an unbounded payload would make an unbounded key.
 *
 * A payload devalue cannot serialize throws HERE rather than one line later in
 * `driver.enqueue`, which already calls `encodePayload` on the same value — the
 * same error, the same call site, marginally earlier.
 */
export const defaultDedupId = (jobName: string, payload: unknown): string =>
  `${jobName}:${createHash('sha256').update(encodePayload(payload).payload).digest('hex').slice(0, 32)}`

export interface ResolveDedupArgs {
  jobName: string
  payload: unknown
  unique?: UniqueOptions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the registry holds jobs of every payload type; the call site has already validated this payload against the job's own schema.
  uniqueId?: (payload: any) => string
}

/**
 * Turns a job's declared policy into the driver-facing option, or `undefined`
 * when the job declares none.
 *
 * A user-supplied `uniqueId` is always NAMESPACED by job name. Without it, two
 * jobs whose functions both return `"1"` would share one dedup key and suppress
 * each other — a cross-job interaction nobody would predict from reading either
 * job.
 */
export const resolveDedup = (
  { jobName, payload, unique, uniqueId }: ResolveDedupArgs,
): DedupOptions | undefined => {
  if (!unique) return undefined

  const id = uniqueId ? `${jobName}:${uniqueId(payload)}` : defaultDedupId(jobName, payload)

  // `debounce` requires a ttl to mean anything: `extend`/`replace` without one
  // is BullMQ's replace-with-no-expiry branch, which is a lock that keeps
  // moving rather than a debounce. Resolution drops it rather than emitting a
  // combination nobody asked for; Task 4 rejects it at definition time, so this
  // branch is unreachable from a real job.
  if (unique.ttl === undefined) return { id }
  if (unique.debounce) return { id, ttl: unique.ttl, extend: true, replace: true }
  return { id, ttl: unique.ttl }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/unit/dedup.test.ts`
Expected: PASS, all cases.

Run: `pnpm lint && pnpm typecheck:tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/server/dedup.ts test/unit/dedup.test.ts
git commit -m "refactor(spec5): derive the default dedup key from the serialized envelope"
```

---

## Task 3: Schedule resolution and reconciliation planning

**Files:**
- Create: `src/runtime/server/cron.ts`
- Test: `test/unit/cron.test.ts`

**Interfaces:**
- Consumes: `CronSpec` from `runtime/server/types.ts`, `ScheduleSpec`/`ScheduleSummary` from
  `drivers/types.ts`.
- Produces: `CRON_DEFAULT_TZ`, `CONCIERGE_SCHEDULE_PREFIX`, `schedulerIdFor(jobName)`,
  `resolveCron(input)`, `nextFireTime(expression, tz, after)`, `planReconciliation(args)`.

The set arithmetic of the sweep is tested as a pure function over (declared, existing) with no
driver at all, so a reconciliation bug cannot hide behind a driver mock.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cron.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  CONCIERGE_SCHEDULE_PREFIX,
  CRON_DEFAULT_TZ,
  nextFireTime,
  planReconciliation,
  resolveCron,
  schedulerIdFor,
} from '../../src/runtime/server/cron'

describe('resolveCron', () => {
  it('accepts the string shorthand and defaults the timezone to UTC', () => {
    // NOT system-local. A laptop and a container disagree, and that
    // disagreement surfaces as "the nightly job ran at the wrong hour in
    // production only".
    expect(resolveCron('0 9 * * *')).toEqual({ expression: '0 9 * * *', tz: 'UTC' })
    expect(CRON_DEFAULT_TZ).toBe('UTC')
  })

  it('accepts the object form and keeps an explicit timezone and payload', () => {
    expect(resolveCron({ expression: '0 9 * * MON', tz: 'America/Toronto', payload: { s: 'w' } }))
      .toEqual({ expression: '0 9 * * MON', tz: 'America/Toronto', payload: { s: 'w' } })
  })

  it('rejects an unparseable expression at resolution time', () => {
    expect(() => resolveCron('not a cron')).toThrow(/not a valid cron expression/)
  })

  it('rejects an unknown timezone', () => {
    expect(() => resolveCron({ expression: '0 9 * * *', tz: 'Mars/Olympus' })).toThrow(/timezone/)
  })
})

describe('nextFireTime', () => {
  it('honours the timezone across a DST transition', () => {
    // Spring-forward in America/Toronto 2027 is Sunday 14 March. A 9am local
    // job stays at 9am local, which means the UTC INSTANT moves by an hour:
    // 14:00Z before, 13:00Z after. These exact values were computed against
    // the installed cron-parser 4.9.0, not derived by hand.
    //
    // This case is what catches tz being dropped or ignored: the UTC control
    // below does not move, so an implementation that silently parses
    // everything as UTC produces 09:00Z here and fails.
    const start = new Date('2027-03-12T20:00:00Z').getTime()
    const first = nextFireTime('0 9 * * *', 'America/Toronto', start)
    expect(new Date(first).toISOString()).toBe('2027-03-13T14:00:00.000Z')

    const second = nextFireTime('0 9 * * *', 'America/Toronto', first)
    expect(new Date(second).toISOString()).toBe('2027-03-14T13:00:00.000Z')
  })

  it('does not move for a UTC schedule across the same window', () => {
    const start = new Date('2027-03-12T20:00:00Z').getTime()
    const first = nextFireTime('0 9 * * *', 'UTC', start)
    expect(new Date(first).toISOString()).toBe('2027-03-13T09:00:00.000Z')
    expect(new Date(nextFireTime('0 9 * * *', 'UTC', first)).toISOString())
      .toBe('2027-03-14T09:00:00.000Z')
  })

  it('returns a time strictly after the reference', () => {
    const at = new Date('2027-01-01T09:00:00Z').getTime()
    expect(nextFireTime('0 9 * * *', 'UTC', at)).toBeGreaterThan(at)
  })
})

describe('schedulerIdFor', () => {
  it('namespaces the id so foreign schedulers are identifiable', () => {
    expect(schedulerIdFor('digest')).toBe(`${CONCIERGE_SCHEDULE_PREFIX}digest`)
  })
})

const summary = (id: string) => ({
  id, jobName: 'x', queue: 'default', expression: '0 * * * *', tz: 'UTC',
})

describe('planReconciliation', () => {
  it('upserts every declared schedule', () => {
    const declared = [{ id: schedulerIdFor('a'), jobName: 'a', expression: '0 * * * *', tz: 'UTC' }]
    const plan = planReconciliation({ declared, existing: [] })
    expect(plan.upserts).toEqual(declared)
    expect(plan.removals).toEqual([])
  })

  it('removes an existing schedule that is no longer declared', () => {
    const plan = planReconciliation({
      declared: [],
      existing: [summary(schedulerIdFor('gone'))],
    })
    expect(plan.removals).toEqual([schedulerIdFor('gone')])
  })

  it('leaves a declared schedule in the removal list alone', () => {
    const declared = [{ id: schedulerIdFor('keep'), jobName: 'keep', expression: '0 * * * *', tz: 'UTC' }]
    const plan = planReconciliation({ declared, existing: [summary(schedulerIdFor('keep'))] })
    // Both halves. "Nothing removed" alone is satisfied by an implementation
    // that never removes anything at all.
    expect(plan.removals).toEqual([])
    expect(plan.upserts).toEqual(declared)
  })

  it('never removes a scheduler it does not own', () => {
    // Someone else's repeatable job on a shared queue. Pruning it would make
    // adopting this module destructive to unrelated BullMQ usage.
    const plan = planReconciliation({
      declared: [],
      existing: [summary('someone-elses-scheduler'), summary(schedulerIdFor('ours'))],
    })
    expect(plan.removals).toEqual([schedulerIdFor('ours')])
  })

  it('re-upserts a declared schedule whose expression changed', () => {
    const declared = [{ id: schedulerIdFor('a'), jobName: 'a', expression: '*/5 * * * *', tz: 'UTC' }]
    const plan = planReconciliation({
      declared,
      existing: [{ ...summary(schedulerIdFor('a')), expression: '0 * * * *' }],
    })
    // Upsert is idempotent and updates in place, so a changed expression needs
    // no removal — asserting the absence is what stops a future "clean first"
    // implementation from opening a window where the schedule does not exist.
    expect(plan.upserts).toEqual(declared)
    expect(plan.removals).toEqual([])
  })

  it('removes everything owned when the declared set is empty', () => {
    // This is `cron.enabled: false`: reconciliation runs with an empty
    // declared set rather than being skipped, so "off" means off in Redis.
    const plan = planReconciliation({
      declared: [],
      existing: [summary(schedulerIdFor('a')), summary(schedulerIdFor('b'))],
    })
    expect(plan.upserts).toEqual([])
    expect(plan.removals.sort()).toEqual([schedulerIdFor('a'), schedulerIdFor('b')].sort())
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/cron.test.ts`
Expected: FAIL with `Cannot find module '.../cron'`.

- [ ] **Step 3: Implement**

Create `src/runtime/server/cron.ts`:

```ts
// DEFAULT IMPORT, NOT NAMED. cron-parser 4.9.0 is CommonJS with no `exports`
// map, and this package is `type: module` — `import { parseExpression } from
// 'cron-parser'` throws `SyntaxError: Named export 'parseExpression' not
// found` at runtime, which no typecheck catches. BullMQ's own ESM source uses
// the named form and gets away with it only because Node resolves BullMQ's CJS
// build. Verified by direct execution; do not "tidy" this back.
import cronParser from 'cron-parser'
import type { CronSpec } from './types'
import type { ScheduleSpec, ScheduleSummary } from './drivers/types'

const { parseExpression } = cronParser

export const CRON_DEFAULT_TZ = 'UTC'

/**
 * Every scheduler this module installs is namespaced. The sweep removes only
 * ids carrying this prefix, so adopting concierge on a queue that already has
 * unrelated BullMQ repeatable jobs does not delete them.
 */
export const CONCIERGE_SCHEDULE_PREFIX = 'concierge:'

export const schedulerIdFor = (jobName: string): string =>
  `${CONCIERGE_SCHEDULE_PREFIX}${jobName}`

export type CronInput = string | { expression: string, tz?: string, payload?: unknown }

/**
 * Normalises the string shorthand and the object form into one shape, and
 * fails loudly on a bad expression or zone.
 *
 * Validation happens HERE, at resolution, rather than at first fire: a
 * `defineJob` with a typo'd expression should be a boot error, not a schedule
 * that silently never runs. That is the v1 cron failure mode this spec exists
 * to not repeat.
 */
export const resolveCron = (input: CronInput): CronSpec => {
  const spec: CronSpec = typeof input === 'string'
    ? { expression: input, tz: CRON_DEFAULT_TZ }
    : { expression: input.expression, tz: input.tz ?? CRON_DEFAULT_TZ, payload: input.payload }

  try {
    // Parsing is the only real validation available for either field.
    parseExpression(spec.expression, { currentDate: new Date(0), tz: spec.tz })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The zone and the expression fail through the same call, so the message
    // is disambiguated by testing the zone independently — otherwise a bad
    // timezone reports as "not a valid cron expression", which sends the
    // reader to the wrong half of their config.
    if (!isValidTimeZone(spec.tz)) {
      throw new Error(
        `[nuxt-concierge] "${spec.tz}" is not a valid IANA timezone.`,
      )
    }
    throw new Error(
      `[nuxt-concierge] "${spec.expression}" is not a valid cron expression: ${message}`,
    )
  }

  return spec
}

const isValidTimeZone = (tz: string): boolean => {
  try {
    // Intl throws RangeError on an unknown zone. Cheaper and more accurate
    // than carrying a zone list that goes stale with every tzdata release.
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  }
  catch {
    return false
  }
}

/**
 * The next fire time strictly after `after`, in milliseconds.
 *
 * `cron-parser` is the single source of schedule arithmetic for BOTH drivers —
 * `bullmq` because its own `defaultRepeatStrategy` uses this exact library and
 * version, `memory` because it calls this function. A second implementation
 * (or a second library, e.g. the `croner` that Nitro drags in) would be a
 * conformance divergence between the driver developers see and the one they
 * deploy, which is the single most expensive class of bug in this project's
 * history.
 */
export const nextFireTime = (expression: string, tz: string, after: number): number =>
  parseExpression(expression, { currentDate: new Date(after), tz }).next().getTime()

export interface ReconciliationPlan {
  upserts: ScheduleSpec[]
  removals: string[]
}

export interface PlanReconciliationArgs {
  /** Every schedule declared for ONE queue. Empty when cron is disabled. */
  declared: ScheduleSpec[]
  /** Every scheduler the driver currently reports for that same queue. */
  existing: ScheduleSummary[]
}

/**
 * Pure set arithmetic, deliberately separated from every driver so the sweep's
 * correctness is testable without Redis, a timer, or a mock.
 *
 * Declared schedules are ALWAYS upserted, including ones that already exist:
 * upsert is idempotent and updates in place, so a changed expression needs no
 * removal — and doing it as remove-then-add would open a window in which the
 * schedule does not exist at all.
 */
export const planReconciliation = (
  { declared, existing }: PlanReconciliationArgs,
): ReconciliationPlan => {
  const declaredIds = new Set(declared.map(s => s.id))

  return {
    upserts: declared,
    removals: existing
      // Ownership check FIRST. Without it, an app adopting concierge on a
      // queue that already carries unrelated repeatable jobs would delete
      // them on its first boot.
      .filter(s => s.id.startsWith(CONCIERGE_SCHEDULE_PREFIX))
      .filter(s => !declaredIds.has(s.id))
      .map(s => s.id),
  }
}
```

- [ ] **Step 4: Add the dependency**

```bash
pnpm add cron-parser@4.9.0
```

Confirm `package.json` records exactly `"cron-parser": "4.9.0"` with no range prefix.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/unit/cron.test.ts`
Expected: PASS, all 13 cases — in particular both DST cases with the exact ISO strings.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/server/cron.ts test/unit/cron.test.ts package.json pnpm-lock.yaml
git commit -m "feat(spec5): schedule resolution and pure reconciliation planning"
```

---

## Task 4: `defineJob` wiring and boot-time cron payload validation

**Files:**
- Modify: `src/runtime/server/handlers/defineJob.ts`
- Modify: `src/runtime/server/cron.ts` (append `validateCronPayloads`)
- Test: `test/unit/defineJob.test.ts`
- Test: `test/unit/cron.test.ts`

**Interfaces:**
- Consumes: `resolveCron`, `CronSpec`, `UniqueOptions` (Tasks 1 and 3).
- Produces: `DefineJobOptions.cron`/`unique`/`uniqueId`; `validateCronPayloads(jobs:
  AnyJobDefinition[]): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/defineJob.test.ts`:

```ts
describe('defineJob cron', () => {
  it('resolves the string shorthand to a full spec', () => {
    const job = defineJob({ cron: '0 9 * * *', handler: async () => {} })
    expect(job.cron).toEqual({ expression: '0 9 * * *', tz: 'UTC' })
  })

  it('keeps an explicit timezone and static payload', () => {
    const job = defineJob({
      cron: { expression: '0 9 * * MON', tz: 'America/Toronto', payload: { scope: 'weekly' } },
      handler: async () => {},
    })
    expect(job.cron).toEqual({
      expression: '0 9 * * MON', tz: 'America/Toronto', payload: { scope: 'weekly' },
    })
  })

  it('throws at definition time on a bad expression', () => {
    expect(() => defineJob({ cron: 'nope', handler: async () => {} }))
      .toThrow(/not a valid cron expression/)
  })

  it('leaves cron undefined for an ordinary job', () => {
    expect(defineJob({ handler: async () => {} }).cron).toBeUndefined()
  })
})

describe('defineJob unique', () => {
  it('resolves `true` to lock mode', () => {
    expect(defineJob({ unique: true, handler: async () => {} }).unique).toEqual({})
  })

  it('keeps a ttl for throttle mode', () => {
    expect(defineJob({ unique: { ttl: 60_000 }, handler: async () => {} }).unique)
      .toEqual({ ttl: 60_000 })
  })

  it('rejects debounce without a ttl', () => {
    // `extend`/`replace` with no expiry is BullMQ's replace-with-no-expiry
    // branch — a lock that keeps moving, not a debounce. Rejecting it at
    // definition time is what makes the combination unrepresentable rather
    // than quietly reinterpreted.
    expect(() => defineJob({ unique: { debounce: true }, handler: async () => {} }))
      .toThrow(/debounce requires a ttl/)
  })

  it('leaves unique undefined for an ordinary job', () => {
    expect(defineJob({ handler: async () => {} }).unique).toBeUndefined()
  })
})
```

Append to `test/unit/cron.test.ts`:

```ts
import { z } from 'zod'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'
import { validateCronPayloads } from '../../src/runtime/server/cron'

describe('validateCronPayloads', () => {
  it('accepts a static payload that satisfies the job schema', async () => {
    const job = defineJob({
      input: z.object({ scope: z.string() }),
      cron: { expression: '0 9 * * *', payload: { scope: 'weekly' } },
      handler: async () => {},
    })
    await expect(validateCronPayloads([job])).resolves.toBeUndefined()
  })

  it('throws at boot when the static payload violates the schema', async () => {
    // Without this, spec 3's consumer-side validation classifies the failure
    // as PERMANENT, so the job dead-letters on every tick forever and nothing
    // about the symptom points at the schedule.
    const job = defineJob({
      name: 'digest',
      input: z.object({ scope: z.string() }),
      cron: { expression: '0 9 * * *', payload: { scope: 42 } },
      handler: async () => {},
    })
    await expect(validateCronPayloads([job])).rejects.toThrow(/digest/)
  })

  it('throws when a schema-bearing cron job supplies no payload at all', async () => {
    const job = defineJob({
      name: 'digest',
      input: z.object({ scope: z.string() }),
      cron: '0 9 * * *',
      handler: async () => {},
    })
    await expect(validateCronPayloads([job])).rejects.toThrow(/digest/)
  })

  it('ignores a cron job with no schema', async () => {
    const job = defineJob({ cron: '0 9 * * *', handler: async () => {} })
    await expect(validateCronPayloads([job])).resolves.toBeUndefined()
  })

  it('ignores a schema-bearing job with no cron', async () => {
    // The ordinary case: payloads come from enqueue callers and are validated
    // there. Asserting it explicitly stops an implementation that validates
    // every job's schema against `undefined` at boot.
    const job = defineJob({ input: z.object({ scope: z.string() }), handler: async () => {} })
    await expect(validateCronPayloads([job])).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run test/unit/defineJob.test.ts test/unit/cron.test.ts`
Expected: FAIL — `cron`/`unique` are not accepted by `defineJob` (typecheck) and are `undefined`
at runtime; `validateCronPayloads` is not exported.

- [ ] **Step 3: Extend `defineJob`**

In `src/runtime/server/handlers/defineJob.ts`, widen `DefineJobOptions` to carry BOTH payload types
and add the three fields:

```ts
/**
 * `In` defaults to `Out` so the no-schema case (where they are the same type)
 * needs no second argument. The two are only distinct when an `input` schema
 * transforms — and `uniqueId` needs `In`, not `Out`.
 */
export interface DefineJobOptions<Out, In = Out> {
  // ... existing fields unchanged ...

  /** A schedule. String shorthand, or the object form for a timezone or payload. */
  cron?: CronInput
  /** `true` is lock mode. `{ ttl }` throttles. `{ ttl, debounce: true }` debounces. */
  unique?: boolean | UniqueOptions
  /**
   * Producer-side key derivation. MUST be pure — an impure key does not fail
   * loudly, it just stops deduplicating.
   *
   * Receives `In`, the ENQUEUE-side payload, NOT `Out`. This runs alongside
   * `validateOnEnqueue`, whose result is deliberately discarded so a
   * transforming schema applies exactly once — in the worker. The transformed
   * value therefore does not exist at the call site, and typing this against
   * `Out` would promise a shape the function is never handed.
   */
  uniqueId?: (payload: In) => string
}
```

Overload 1 becomes `DefineJobOptions<StandardSchemaV1.InferOutput<S>, StandardSchemaV1.InferInput<S>>
& { input: S }`; overload 2 stays `DefineJobOptions<Payload> & { input?: never }`, where `In`
defaults to `Payload`. Add all three fields to the implementation signature too, then in the
implementation body:

```ts
  if (opts.unique && typeof opts.unique === 'object' && opts.unique.debounce
    && opts.unique.ttl === undefined) {
    throw new Error(
      '[nuxt-concierge] unique.debounce requires a ttl. Without an expiry, `extend` and '
      + '`replace` produce a lock that keeps moving rather than a debounce window.',
    )
  }

  const unique = opts.unique === true
    ? {}
    : opts.unique === false || opts.unique === undefined
      ? undefined
      : opts.unique
```

and add to the returned object, after `backoff`:

```ts
    // Resolved HERE rather than at boot so a typo'd expression throws where
    // the job is written, with that file already on the stack.
    cron: opts.cron === undefined ? undefined : resolveCron(opts.cron),
    unique,
    uniqueId: opts.uniqueId as JobDefinition['uniqueId'],
```

> `uniqueId` is cast because `DefineJobOptions<Out>` types it against the
> concrete payload while `JobDefinition` holds it contravariantly for the
> collection type. This is the same accommodation `handler`/`run` already
> makes, and for the same reason.

- [ ] **Step 4: Add `validateCronPayloads`**

Append to `src/runtime/server/cron.ts`:

```ts
import type { AnyJobDefinition } from './types'

/**
 * Boot-time check that every scheduled job's STATIC payload satisfies its own
 * `input` schema.
 *
 * Build time cannot do this: spec 3 established that validation requires
 * EXECUTING a schema, which is exactly why AST extraction was dropped rather
 * than deferred. Boot can, because the schema is a live object by then.
 *
 * The failure this prevents is nasty and silent-adjacent: consumer-side
 * validation throws `JobPayloadInvalidError` with `retryable = false`, so both
 * drivers classify it as PERMANENT. A schema-violating cron payload therefore
 * dead-letters on every single tick, forever, and the failed job says nothing
 * about a schedule being the cause.
 *
 * A startup error, consistent with how `resolveRole` and
 * `validateHistoryLimit` already treat config mistakes.
 */
export const validateCronPayloads = async (jobs: AnyJobDefinition[]): Promise<void> => {
  for (const job of jobs) {
    if (!job.cron || !job.input) continue

    const result = await job.input['~standard'].validate(job.cron.payload)
    if (!result.issues) continue

    // Issue MESSAGES are included here, unlike `validateOnConsume`'s. This
    // text goes to the boot log of the process the developer is starting, from
    // a payload written in their own source file — it never reaches the queue
    // backend and carries no user data. Withholding detail here would just
    // make a boot failure harder to fix.
    const detail = result.issues
      .map(issue => `${formatIssuePath(issue)}: ${issue.message}`)
      .join('; ')

    throw new Error(
      `[nuxt-concierge] the cron payload for job "${job.name}" does not satisfy its own input `
      + `schema — ${detail}. A scheduled job whose payload fails validation dead-letters on `
      + `every tick, because payload validation failures are permanent by design.`,
    )
  }
}
```

Add `import { formatIssuePath } from './validate'` at the top of `cron.ts`.

- [ ] **Step 5: Write the type tests**

These are the only coverage that can see this task's actual deliverable — every runtime test above
still passes if `uniqueId` is typed `any`. Append to `test/types/defineJob.test-d.ts`:

```ts
import { expectTypeOf } from 'vitest'
import { z } from 'zod'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'

// `uniqueId` receives the schema INPUT, not its output. Here the schema
// transforms string -> number, so `Out` is `{ n: number }` and `In` is
// `{ n: string }`; typing against `Out` would promise the handler's shape to a
// function that runs before the transform ever applies.
defineJob({
  input: z.object({ n: z.string().transform(Number) }),
  uniqueId: (payload) => {
    expectTypeOf(payload).toEqualTypeOf<{ n: string }>()
    return payload.n
  },
  handler: async (ctx) => {
    // Paired with the above deliberately: the handler DOES see the output.
    // Asserting only the uniqueId side would pass for an implementation that
    // typed both as the input.
    expectTypeOf(ctx.payload).toEqualTypeOf<{ n: number }>()
  },
})

// The no-schema case: In defaults to Out, so both are the type argument.
defineJob<{ id: number }>({
  uniqueId: (payload) => {
    expectTypeOf(payload).toEqualTypeOf<{ id: number }>()
    return String(payload.id)
  },
  handler: async () => {},
})

// `ctx.cron` is optional and correctly shaped on every job, scheduled or not —
// a handler cannot know at compile time whether a given run came from a tick.
defineJob({
  cron: '0 9 * * *',
  handler: async (ctx) => {
    expectTypeOf(ctx.cron).toEqualTypeOf<{ tick: number, expression: string, tz: string } | undefined>()
  },
})

// @ts-expect-error — a cron job may not declare an unknown option, which is
// what keeps a typo'd `crons:` from silently defining a job that never fires.
defineJob({ crons: '0 9 * * *', handler: async () => {} })

// The positive twin of the negative above. `@ts-expect-error` passes if ANY
// error occurs on the line, including an unrelated typo, so it proves nothing
// without this.
defineJob({ cron: '0 9 * * *', handler: async () => {} })
```

Append to `test/types/enqueue.test-d.ts`, following that file's documented convention: the real
`ConciergeJobMap` is an ambient build-time declaration a type test **cannot import**, so the file
already asserts against a local `TestJobMap` built from `EnqueueInputOf`. Extend that stand-in
rather than referencing `ConciergeJobMap` directly.

```ts
// A cron job is an ordinary map member with its payload type intact — which is
// what makes dashboard run-now an `enqueue` call rather than a second write
// path. Declaring `cron` must not collapse the payload to `unknown`, which is
// exactly what would happen if the new option disturbed EnqueueInputOf's
// two-parameter inference.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used below via `typeof digest`, a type-only reference
const digest = defineJob({
  input: z.object({ scope: z.string() }),
  cron: { expression: '0 9 * * MON', payload: { scope: 'weekly' } },
  handler: () => {},
})

expectTypeOf<EnqueueInputOf<typeof digest>>().toEqualTypeOf<{ scope: string }>()
```

> `test/unit/templates.test.ts` covers the generator's emitted text; together
> the two halves cover "a cron job reaches the generated map with its payload
> type", which neither can assert alone.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/unit/defineJob.test.ts test/unit/cron.test.ts`
Expected: PASS.

Run: `pnpm test:types && pnpm typecheck:tests && pnpm typecheck:public`
Expected: PASS. `vitest` does not typecheck, so the runtime run above cannot catch a `uniqueId`
typed against the wrong side — only `test:types` can.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/handlers/defineJob.ts src/runtime/server/cron.ts \
  test/unit/defineJob.test.ts test/unit/cron.test.ts test/types/
git commit -m "feat(spec5): defineJob cron and unique, with boot-time payload validation"
```

---

## Task 5: `memory` driver deduplication

**Files:**
- Modify: `src/runtime/server/drivers/memory.ts`
- Test: `test/unit/drivers/memory-dedup.test.ts`

**Interfaces:**
- Consumes: `DedupOptions`, `EnqueueResult` (Task 1).
- Produces: no new exports. `createMemoryDriver().enqueue` honours `job.dedup`; `introspect.get`
  returns `deduplicationId`.

Full parity on all three modes, not partial. This is spec 3's most expensive lesson restated:
BullMQ's default `attempts: 0` meant a failing job was never retried in production while `memory`
retried it three times — *the forgiving driver was the one developers saw*. Dedup divergence is
worse than retry divergence, because the symptom is a job that silently never ran.

- [ ] **Step 1: Write the failing test**

Create `test/unit/drivers/memory-dedup.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createMemoryDriver } from '../../../src/runtime/server/drivers/memory'

const flush = () => new Promise(r => setTimeout(r, 60))

describe('memory driver deduplication — lock mode', () => {
  it('suppresses a second enqueue while the first is queued', async () => {
    const driver = createMemoryDriver()
    const first = await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })
    const second = await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })

    // Both halves. "deduplicated is true" alone is satisfied by an
    // implementation that also drops the FIRST job.
    expect(second).toEqual({ id: first.id, deduplicated: true })
    expect((await driver.introspect!.counts('default')).waiting).toBe(1)
  })

  it('releases the key when the job completes', async () => {
    const driver = createMemoryDriver()
    driver.registerHandler('default', 'j', async () => {})
    driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })
    await flush()

    const after = await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })
    expect(after.deduplicated).toBe(false)
  })

  it('releases the key on TERMINAL failure', async () => {
    const driver = createMemoryDriver()
    driver.registerHandler('default', 'j', async () => { throw new Error('boom') })
    driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' }, attempts: 1 })
    await flush()

    expect((await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })).deduplicated)
      .toBe(false)
  })

  it('does NOT release the key on an intermediate failure', async () => {
    // The case most likely to be got wrong. Retries move a job through
    // moveToDelayed/retryJob, never moveToFinished, so a job with attempts: 3
    // holds its key across all three. An implementation that releases on every
    // catch lets a duplicate in mid-retry — and every other case in this file
    // still passes.
    const driver = createMemoryDriver()
    let calls = 0
    driver.registerHandler('default', 'j', async () => {
      calls++
      throw new Error('boom')
    })
    driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', {
      name: 'j', payload: {}, dedup: { id: 'k' }, attempts: 3,
      backoff: { type: 'fixed', delay: 5_000 },
    })
    // Long backoff so the job is provably mid-retry, not finished, when the
    // duplicate arrives. A short delay here would make this test a race.
    await flush()
    expect(calls).toBe(1)

    const dup = await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k' } })
    expect(dup.deduplicated).toBe(true)
  })
})

describe('memory driver deduplication — throttle mode', () => {
  it('keeps the key after the job finishes, until the ttl expires', async () => {
    vi.useFakeTimers()
    try {
      const driver = createMemoryDriver()
      await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k', ttl: 60_000 } })

      vi.setSystemTime(Date.now() + 30_000)
      expect((await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k', ttl: 60_000 } })).deduplicated)
        .toBe(true)

      vi.setSystemTime(Date.now() + 31_000)
      expect((await driver.enqueue('default', { name: 'j', payload: {}, dedup: { id: 'k', ttl: 60_000 } })).deduplicated)
        .toBe(false)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('memory driver deduplication — debounce mode', () => {
  it('collapses a burst into one job carrying the LAST payload', async () => {
    const driver = createMemoryDriver()
    const opts = { name: 'j', dedup: { id: 'k', ttl: 60_000, extend: true, replace: true }, delay: 10_000 }

    await driver.enqueue('default', { ...opts, payload: { n: 1 } })
    await driver.enqueue('default', { ...opts, payload: { n: 2 } })
    const last = await driver.enqueue('default', { ...opts, payload: { n: 3 } })

    expect((await driver.introspect!.counts('default')).delayed).toBe(1)
    // The LAST payload, not the first. This is what `replace` means and it is
    // the only assertion that distinguishes debounce from throttle — under
    // throttle this job would carry { n: 1 }.
    const detail = await driver.introspect!.get('default', last.id)
    expect(detail?.deduplicationId).toBe('k')
  })
})

describe('memory driver deduplication — absent', () => {
  it('does not deduplicate when no dedup option is supplied', async () => {
    const driver = createMemoryDriver()
    await driver.enqueue('default', { name: 'j', payload: {} })
    await driver.enqueue('default', { name: 'j', payload: {} })
    expect((await driver.introspect!.counts('default')).waiting).toBe(2)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/drivers/memory-dedup.test.ts`
Expected: FAIL. Every dedup case reports `deduplicated: false` and both jobs are enqueued, because
`job.dedup` is currently ignored.

- [ ] **Step 3: Add dedup state to the memory driver**

In `src/runtime/server/drivers/memory.ts`, add `dedup?: DedupOptions` to the `QueuedJob` interface
and `dedupId?: string` to `TerminalRecord`. Then inside `createMemoryDriver`, alongside the other
maps:

```ts
  /**
   * Dedup keys, scoped by queue exactly as BullMQ's are (its key is
   * `<prefix>:<queue>:de:<id>`), so the same id on two queues does not collide.
   *
   * `expiresAt` is checked LAZILY on read rather than with a timer per key. A
   * timer per key is a leak the driver would have to track and tear down, for
   * no benefit in a driver whose entire lifetime is bounded by the process.
   */
  const dedupKeys = new Map<string, { jobId: string, expiresAt?: number }>()

  const dedupKey = (queue: string, id: string) => `${queue}::${id}`

  const liveDedup = (queue: string, id: string) => {
    const entry = dedupKeys.get(dedupKey(queue, id))
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      dedupKeys.delete(dedupKey(queue, id))
      return undefined
    }
    return entry
  }

  /**
   * Mirrors `removeDeduplicationKeyIfNeededOnFinalization` in
   * bullmq/dist/esm/scripts/moveToFinished-14.js: a key with NO expiry is
   * deleted when the job finalizes; a key WITH one is left to expire. That
   * asymmetry is the whole difference between lock mode and throttle mode, and
   * `memory` has to reproduce it exactly or the two drivers disagree about
   * which enqueues are suppressed.
   *
   * The `jobId` guard mirrors BullMQ's `currentJobId == jobId` check: a key
   * already re-taken by a newer job must not be released by an older one
   * finishing.
   */
  const releaseDedupOnFinalize = (queue: string, id: string | undefined, jobId: string) => {
    if (!id) return
    const k = dedupKey(queue, id)
    const entry = dedupKeys.get(k)
    if (!entry || entry.expiresAt !== undefined) return
    if (entry.jobId === jobId) dedupKeys.delete(k)
  }
```

- [ ] **Step 4: Honour `dedup` in `enqueue`**

Replace the body of `memory.ts`'s `enqueue`:

```ts
    enqueue: async (queue, job) => {
      if (job.dedup) {
        const k = dedupKey(queue, job.dedup.id)
        const existing = liveDedup(queue, job.dedup.id)

        if (existing) {
          if (job.dedup.replace) {
            // DEBOUNCE. Supersede the pending job so the burst collapses onto
            // the LAST payload, and re-arm the window when `extend` is set.
            // Only a job still WAITING can be replaced — one already running
            // or finished is not "pending" in any sense BullMQ's own
            // removeDelayedJob would recognise.
            const q = queueOf(queue)
            const idx = q.findIndex(j => j.id === existing.jobId)
            if (idx !== -1) {
              q.splice(idx, 1)
              const id = `mem-${++counter}`
              q.push(buildQueuedJob(id, queue, job))
              dedupKeys.set(k, {
                jobId: id,
                expiresAt: job.dedup.extend && job.dedup.ttl !== undefined
                  ? Date.now() + job.dedup.ttl
                  : existing.expiresAt,
              })
              return { id, deduplicated: false }
            }
          }
          else if (job.dedup.extend && job.dedup.ttl !== undefined) {
            // Sliding window without replacement: re-arm, keep the original.
            dedupKeys.set(k, { jobId: existing.jobId, expiresAt: Date.now() + job.dedup.ttl })
          }

          return { id: existing.jobId, deduplicated: true }
        }

        const id = `mem-${++counter}`
        queueOf(queue).push(buildQueuedJob(id, queue, job))
        dedupKeys.set(k, {
          jobId: id,
          expiresAt: job.dedup.ttl !== undefined ? Date.now() + job.dedup.ttl : undefined,
        })
        return { id, deduplicated: false }
      }

      const id = `mem-${++counter}`
      queueOf(queue).push(buildQueuedJob(id, queue, job))
      return { id, deduplicated: false }
    },
```

Add the shared constructor just above the returned object, so the three enqueue paths cannot drift:

```ts
  const buildQueuedJob = (id: string, queue: string, job: EnqueueOptions): QueuedJob => ({
    id,
    name: job.name,
    queue,
    envelope: encodePayload(job.payload),
    attempt: 0,
    runAt: Date.now() + (job.delay ?? 0),
    attempts: job.attempts,
    backoff: job.backoff,
    createdAt: Date.now(),
    dedup: job.dedup,
  })
```

Import `EnqueueOptions` and `DedupOptions` from `./types`.

- [ ] **Step 5: Release the key on finalization only**

In `run`'s success path, immediately before the `remember({ ... state: 'completed' ... })` call,
and in the terminal branch of the failure path immediately before `remember({ ... state: 'failed'
... })`, add:

```ts
          releaseDedupOnFinalize(queue, job.dedup?.id, job.id)
```

Do **not** add it to the `willRetry` branch — that is the intermediate-failure case, and releasing
there is exactly the defect the fourth lock-mode test exists to catch.

Add `dedupId: job.dedup?.id` to both `remember({...})` calls, and `deduplicationId: record.dedupId`
to `toDetail`. In `introspect.get`'s queued-job branch, add `deduplicationId: queued.dedup?.id`.

- [ ] **Step 6: Clear dedup state on close**

In `close`, alongside `pending.clear()`:

```ts
      dedupKeys.clear()
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run test/unit/drivers/memory-dedup.test.ts test/unit/drivers/memory.test.ts test/unit/drivers/memory-history.test.ts`
Expected: PASS. The two existing memory suites must stay green — a regression there means the
`buildQueuedJob` extraction changed behaviour.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/server/drivers/memory.ts test/unit/drivers/memory-dedup.test.ts
git commit -m "feat(spec5): memory driver deduplication with lock, throttle and debounce modes"
```

---

## Task 6: `bullmq` driver deduplication

**Files:**
- Modify: `src/runtime/server/drivers/bullmq.ts:285-299` and `:226-244`
- Test: `test/unit/drivers/bullmq-mapping.test.ts`

**Interfaces:**
- Consumes: `DedupOptions`, `EnqueueResult` (Task 1).
- Produces: `bullmqAddOptions(job: EnqueueOptions): JobsOptions` — exported and pure, so the
  mapping is testable without Redis. The round trip is covered by Task 9's conformance table,
  which does need one.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/drivers/bullmq-mapping.test.ts`:

```ts
import { bullmqAddOptions } from '../../../src/runtime/server/drivers/bullmq'

describe('bullmqAddOptions', () => {
  it('passes dedup straight through with no translation', () => {
    // Straight through, deliberately: EnqueueOptions.dedup is shaped exactly
    // like BullMQ's DeduplicationOptions. A translation layer here is where a
    // semantic drift would hide, the same reasoning that keeps BackoffOptions
    // shaped like BullMQ's own.
    const opts = bullmqAddOptions({
      name: 'j', payload: {}, dedup: { id: 'k', ttl: 5_000, extend: true, replace: true },
    })
    expect(opts.deduplication).toEqual({ id: 'k', ttl: 5_000, extend: true, replace: true })
  })

  it('omits deduplication entirely when the job declares none', () => {
    // `undefined` rather than `{}`: BullMQ branches on the option's presence,
    // and an empty object with no `id` would take the deduplicate path with an
    // undefined key.
    expect(bullmqAddOptions({ name: 'j', payload: {} }).deduplication).toBeUndefined()
  })

  it('never sets the deprecated debounce option', () => {
    // `debounce` is deprecated in favour of `deduplication` in 5.63.0 and
    // takes the identical shape, so building on it would work today and break
    // silently at the v6 removal.
    const opts = bullmqAddOptions({ name: 'j', payload: {}, dedup: { id: 'k' } })
    expect(opts).not.toHaveProperty('debounce')
  })

  it('still carries attempts, backoff and delay', () => {
    const opts = bullmqAddOptions({
      name: 'j', payload: {}, delay: 100, attempts: 3, backoff: { type: 'fixed', delay: 50 },
    })
    expect(opts.delay).toBe(100)
    expect(opts.attempts).toBe(3)
    expect(opts.backoff).toEqual({ type: 'fixed', delay: 50 })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/drivers/bullmq-mapping.test.ts`
Expected: FAIL with `bullmqAddOptions is not a function`.

- [ ] **Step 3: Extract and extend the add-options mapping**

In `src/runtime/server/drivers/bullmq.ts`, add above `createBullmqDriver`:

```ts
/**
 * Projects `EnqueueOptions` onto BullMQ's own job options. Exported and pure so
 * the mapping is testable without a live Redis.
 */
export const bullmqAddOptions = (job: EnqueueOptions): JobsOptions => ({
  delay: job.delay,
  // Straight through, no arithmetic: EnqueueOptions.attempts already means
  // what BullMQ's attempts means.
  attempts: job.attempts,
  backoff: job.backoff,
  // Straight through for the same reason. Note `deduplication`, never the
  // deprecated `debounce` — they take the identical shape in 5.63.0, which is
  // exactly what would make building on the wrong one look fine until v6.
  deduplication: job.dedup,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
})
```

Import `JobsOptions` from `bullmq` and `EnqueueOptions` from `./types`.

- [ ] **Step 4: Detect suppression in `enqueue`**

BullMQ's `add()` returns the *existing* `Job` when an enqueue is suppressed, and offers no flag of
its own — nothing on the returned job distinguishes "you created this" from "this already existed",
because the id is the returned job's id in both cases. The reliable check is to read the current
holder of the dedup key **before** adding and compare after.

`Queue.getDeduplicationJobId` does **not** exist in 5.63.0 — verified; the only public dedup method
is `removeDeduplicationKey(id)`. So the key is read directly, via BullMQ's own key base rather than
a hardcoded string.

Replace `enqueue` with:

```ts
    enqueue: async (queue, job) => {
      const q = queueOf(queue)

      // Read the current holder of the dedup key BEFORE adding.
      //
      // `q.keys.de` is BullMQ's own dedup key base (prefix + queue name),
      // exposed as the typed `KeysMap` on `QueueBase` and used by
      // `Scripts.addJob` itself to build `${keys.de}:${deduplicationId}`
      // (scripts.js:139). Reading from there rather than hardcoding
      // `bull:<queue>:de:` means a prefix change cannot silently make this
      // read the wrong key and report every suppressed enqueue as fresh —
      // which would be a wrong `deduplicated` flag with no other symptom.
      const before = job.dedup
        ? await client().get(`${q.keys.de}:${job.dedup.id}`)
        : null

      const added = await q.add(job.name, encodePayload(job.payload), bullmqAddOptions(job))
      const id = String(added.id)

      // The key was already held by the very job we were handed back: this
      // call added nothing.
      return { id, deduplicated: before !== null && before === id }
    },
```

- [ ] **Step 5: Surface `deduplicationId` on the detail view**

In `introspect.get`, add to the returned object:

```ts
          deduplicationId: job.deduplicationId ?? undefined,
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/unit/drivers/bullmq-mapping.test.ts test/unit/drivers/bullmq-introspect.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/drivers/bullmq.ts test/unit/drivers/bullmq-mapping.test.ts
git commit -m "feat(spec5): bullmq deduplication pass-through and deduplicationId on job detail"
```

---

## Task 7: `memory` driver scheduling

**Files:**
- Modify: `src/runtime/server/drivers/memory.ts`
- Modify: `src/runtime/server/drivers/types.ts` (adds `EnqueueOptions.cron`, in Step 3)
- Test: `test/unit/drivers/memory-schedule.test.ts`

**Interfaces:**
- Consumes: `nextFireTime` from `runtime/server/cron.ts`, `DriverScheduling`, `ScheduleSpec`,
  `ScheduleSummary` (Tasks 1 and 3).
- Produces: `createMemoryDriver().schedule` implementing all three methods.

- [ ] **Step 1: Write the failing test**

Create `test/unit/drivers/memory-schedule.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDriver } from '../../../src/runtime/server/drivers/memory'
import { schedulerIdFor } from '../../../src/runtime/server/cron'

const spec = (jobName: string, expression = '0 * * * *') => ({
  id: schedulerIdFor(jobName), jobName, expression, tz: 'UTC',
})

afterEach(() => { vi.useRealTimers() })

describe('memory driver scheduling', () => {
  it('declares scheduling support', () => {
    expect(createMemoryDriver().schedule).toBeDefined()
  })

  it('lists an upserted schedule with its next fire time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T00:30:00Z'))

    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest'))

    const listed = await driver.schedule!.list('default')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: schedulerIdFor('digest'), jobName: 'digest', queue: 'default',
      expression: '0 * * * *', tz: 'UTC',
    })
    expect(new Date(listed[0]!.next!).toISOString()).toBe('2027-01-01T01:00:00.000Z')

    await driver.close(true)
  })

  it('is idempotent — two upserts of the same id yield one schedule', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest'))
    await driver.schedule!.upsert('default', spec('digest'))
    expect(await driver.schedule!.list('default')).toHaveLength(1)
    await driver.close(true)
  })

  it('updates in place when the expression changes', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest', '0 * * * *'))
    await driver.schedule!.upsert('default', spec('digest', '*/5 * * * *'))

    const listed = await driver.schedule!.list('default')
    // Both halves: one row, AND it is the new expression. "Length is 1" alone
    // passes for an implementation that ignores the second upsert entirely.
    expect(listed).toHaveLength(1)
    expect(listed[0]!.expression).toBe('*/5 * * * *')
    await driver.close(true)
  })

  it('scopes schedules to their queue', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('a', spec('one'))
    await driver.schedule!.upsert('b', spec('two'))
    expect(await driver.schedule!.list('a')).toHaveLength(1)
    expect(await driver.schedule!.list('b')).toHaveLength(1)
    await driver.close(true)
  })

  it('removes a schedule', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest'))
    await driver.schedule!.remove('default', schedulerIdFor('digest'))
    expect(await driver.schedule!.list('default')).toEqual([])
    await driver.close(true)
  })

  it('enqueues a job when the tick arrives, carrying the tick time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T00:59:59Z'))

    const driver = createMemoryDriver()
    const seen: Array<{ tick: number, expression: string, tz: string }> = []
    driver.registerHandler('default', 'digest', async (ctx) => { seen.push(ctx.cron!) })
    driver.consume('default', { concurrency: 1 })
    await driver.schedule!.upsert('default', spec('digest'))

    await vi.advanceTimersByTimeAsync(2_000)
    vi.useRealTimers()
    await new Promise(r => setTimeout(r, 60))

    expect(seen).toHaveLength(1)
    // The SCHEDULED time, not the time the handler started. Asserting the
    // exact instant is what catches an implementation that passes Date.now().
    expect(new Date(seen[0]!.tick).toISOString()).toBe('2027-01-01T01:00:00.000Z')
    expect(seen[0]!.expression).toBe('0 * * * *')
    expect(seen[0]!.tz).toBe('UTC')

    await driver.close(true)
  })

  it('stops firing after close', async () => {
    const driver = createMemoryDriver()
    await driver.schedule!.upsert('default', spec('digest', '* * * * *'))
    await driver.close(true)
    expect(await driver.schedule!.list('default')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/drivers/memory-schedule.test.ts`
Expected: FAIL — `driver.schedule` is `undefined`, so the first case fails and the rest throw on
`schedule!.upsert`.

- [ ] **Step 3: Implement scheduling**

Add to `QueuedJob`: `cron?: { tick: number, expression: string, tz: string }`, and thread it
through `buildQueuedJob` as `cron: job.cron`. Add `cron?: { tick, expression, tz }` to
`EnqueueOptions` in `drivers/types.ts`:

```ts
  /**
   * Set only by a driver's own scheduler when producing a tick, never by
   * `useQueue`. It is what populates `JobContext.cron`.
   */
  cron?: { tick: number, expression: string, tz: string }
```

Then in `memory.ts`, inside `createMemoryDriver`:

```ts
  interface ScheduleEntry {
    spec: ScheduleSpec
    queue: string
    next: number
    iterationCount: number
    timer?: ReturnType<typeof setTimeout>
  }

  const schedules = new Map<string, ScheduleEntry>()
  const scheduleKey = (queue: string, id: string) => `${queue}::${id}`

  /**
   * Arms one timer for the NEXT tick only, re-arming after each fire — never a
   * setInterval. A cron expression's gaps are not uniform (month lengths, DST),
   * so an interval would drift; and one live timer per schedule is what makes
   * `close()` able to stop everything deterministically.
   */
  const arm = (key: string) => {
    const entry = schedules.get(key)
    if (!entry) return

    const delay = Math.max(0, entry.next - Date.now())
    entry.timer = setTimeout(() => {
      const current = schedules.get(key)
      if (!current) return

      void driverSelf.enqueue(current.queue, {
        name: current.spec.jobName,
        payload: current.spec.payload,
        cron: {
          // The SCHEDULED time, not Date.now(). They differ by timer latency,
          // and only the scheduled time is stable across a retry of this tick.
          tick: current.next,
          expression: current.spec.expression,
          tz: current.spec.tz,
        },
      })

      current.iterationCount++
      current.next = nextFireTime(current.spec.expression, current.spec.tz, current.next)
      arm(key)
    }, delay)
    // Never holds the process open on its own — only real work should. Matches
    // how the supervisor's heartbeat interval is handled.
    entry.timer.unref?.()
  }

  const disarm = (entry: ScheduleEntry) => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
  }
```

`driverSelf` is the returned driver object; assign it to a `const driverSelf: ConciergeDriver = { ... }`
and `return driverSelf` at the end, so the timer can enqueue through the driver's own path (and
therefore through dedup) rather than duplicating `buildQueuedJob`.

Add the `schedule` implementation to the returned object, next to `introspect`:

```ts
    schedule: {
      upsert: async (queue, spec) => {
        const key = scheduleKey(queue, spec.id)
        const existing = schedules.get(key)
        // Update IN PLACE rather than remove-then-add: a remove-then-add would
        // open a window in which the schedule does not exist, and would reset
        // iterationCount on every boot of every instance.
        if (existing) disarm(existing)

        schedules.set(key, {
          spec,
          queue,
          next: nextFireTime(spec.expression, spec.tz, Date.now()),
          iterationCount: existing?.iterationCount ?? 0,
        })
        arm(key)
      },

      list: async queue => [...schedules.values()]
        .filter(e => e.queue === queue)
        .map(e => ({
          id: e.spec.id,
          jobName: e.spec.jobName,
          queue: e.queue,
          expression: e.spec.expression,
          tz: e.spec.tz,
          next: e.next,
          iterationCount: e.iterationCount,
        })),

      remove: async (queue, id) => {
        const key = scheduleKey(queue, id)
        const entry = schedules.get(key)
        if (entry) disarm(entry)
        schedules.delete(key)
      },
    },
```

In `close`, before `pending.clear()`:

```ts
      for (const entry of schedules.values()) disarm(entry)
      schedules.clear()
```

- [ ] **Step 4: Deliver `ctx.cron` to the handler**

In `run`, add `cron: job.cron` to the object passed to `handler({ ... })`.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/unit/drivers/memory-schedule.test.ts test/unit/drivers/memory.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/server/drivers/memory.ts src/runtime/server/drivers/types.ts \
  test/unit/drivers/memory-schedule.test.ts
git commit -m "feat(spec5): memory driver scheduling with cron-parser timers"
```

---

## Task 8: `bullmq` driver scheduling

**Files:**
- Modify: `src/runtime/server/drivers/bullmq.ts`
- Test: `test/unit/drivers/bullmq-schedule.test.ts`

**Interfaces:**
- Consumes: `ScheduleSpec`, `ScheduleSummary`, `DriverScheduling` (Task 1).
- Produces: `createBullmqDriver().schedule`; `schedulerToSummary(json, queue): ScheduleSummary`;
  `cronContextFromJob(job): { tick, expression, tz } | undefined` — both exported and pure.

- [ ] **Step 1: Write the failing test**

Create `test/unit/drivers/bullmq-schedule.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cronContextFromJob, schedulerToSummary } from '../../../src/runtime/server/drivers/bullmq'
import { schedulerIdFor } from '../../../src/runtime/server/cron'

describe('schedulerToSummary', () => {
  it('maps a JobSchedulerJson onto the canonical summary', () => {
    const summary = schedulerToSummary({
      key: schedulerIdFor('digest'),
      name: 'digest',
      pattern: '0 9 * * *',
      tz: 'America/Toronto',
      next: 1_800_000_000_000,
      iterationCount: 4,
    }, 'default')

    expect(summary).toEqual({
      id: schedulerIdFor('digest'),
      jobName: 'digest',
      queue: 'default',
      expression: '0 9 * * *',
      tz: 'America/Toronto',
      next: 1_800_000_000_000,
      iterationCount: 4,
    })
  })

  it('defaults an absent tz to UTC rather than leaving it undefined', () => {
    // BullMQ omits `tz` when the schedule was created without one. Leaving it
    // undefined would make the Schedules panel render a blank column for every
    // UTC schedule, which reads as "unknown" rather than "UTC".
    const summary = schedulerToSummary({ key: 'k', name: 'j', pattern: '0 * * * *' }, 'default')
    expect(summary.tz).toBe('UTC')
  })
})

describe('cronContextFromJob', () => {
  it('extracts the tick from prevMillis when present', () => {
    expect(cronContextFromJob({
      id: `repeat:${schedulerIdFor('digest')}:1800000000000`,
      repeatJobKey: schedulerIdFor('digest'),
      opts: { prevMillis: 1_800_000_000_000, repeat: { pattern: '0 9 * * *', tz: 'UTC' } },
    })).toEqual({ tick: 1_800_000_000_000, expression: '0 9 * * *', tz: 'UTC' })
  })

  it('falls back to the tick encoded in the job id', () => {
    // BullMQ's getSchedulerNextJobId builds `repeat:<schedulerId>:<millis>`
    // (job-scheduler.js:220-222), and the id is stable across a retry because
    // the job record is reused. `prevMillis` is documented as internal, so the
    // id is the more durable of the two — both are read, neither is trusted
    // alone.
    expect(cronContextFromJob({
      id: `repeat:${schedulerIdFor('digest')}:1800000000000`,
      repeatJobKey: schedulerIdFor('digest'),
      opts: { repeat: { pattern: '0 9 * * *' } },
    })).toEqual({ tick: 1_800_000_000_000, expression: '0 9 * * *', tz: 'UTC' })
  })

  it('returns undefined for an ordinary enqueued job', () => {
    // Paired with the positive cases deliberately: an implementation that
    // always returns a context would satisfy both of those.
    expect(cronContextFromJob({ id: '42', opts: {} })).toBeUndefined()
  })

  it('returns undefined when the id is unparseable and prevMillis is absent', () => {
    expect(cronContextFromJob({
      id: 'repeat:weird', repeatJobKey: 'x', opts: { repeat: { pattern: '0 * * * *' } },
    })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/drivers/bullmq-schedule.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement the pure mappings**

Add to `src/runtime/server/drivers/bullmq.ts`:

```ts
/**
 * Projects BullMQ's `JobSchedulerJson` onto the canonical summary.
 *
 * There is deliberately no `last` field: `JobSchedulerJson` in 5.63.0 exposes
 * `key`, `name`, `id`, `iterationCount`, `limit`, `startDate`, `endDate`, `tz`,
 * `pattern`, `every`, `next`, `offset` and `template` — and no previous-fire
 * time. `RepeatOptions.prevMillis` is marked internal and is not returned.
 */
export const schedulerToSummary = (
  json: { key: string, name: string, pattern?: string, tz?: string, next?: number, iterationCount?: number },
  queue: string,
): ScheduleSummary => ({
  id: json.key,
  jobName: json.name,
  queue,
  expression: json.pattern ?? '',
  // BullMQ omits tz for a schedule created without one; that means UTC, and
  // saying so beats rendering a blank column that reads as "unknown".
  tz: json.tz ?? 'UTC',
  next: json.next,
  iterationCount: json.iterationCount,
})

/** The tick millis encoded in a scheduler-produced job id: `repeat:<id>:<millis>`. */
const tickFromJobId = (id: string | undefined): number | undefined => {
  const millis = Number(id?.slice(id.lastIndexOf(':') + 1))
  return id?.startsWith('repeat:') && Number.isFinite(millis) && millis > 0 ? millis : undefined
}

/**
 * Recovers a scheduled job's tick metadata, or `undefined` for an ordinary job.
 *
 * `repeatJobKey` is the detector: BullMQ sets it on every scheduler-produced
 * job (`job-scheduler.js:120`) and on nothing else. The tick comes from
 * `opts.prevMillis` when present, falling back to the millis encoded in the job
 * id by `getSchedulerNextJobId` (`repeat:<schedulerId>:<nextMillis>`,
 * `job-scheduler.js:220-222`). Both are read because `prevMillis` is documented
 * as an internal property, and the id format is a public consequence of a
 * documented method — neither is load-bearing alone.
 *
 * The tick is stable across a retry either way: BullMQ retries the same job
 * record, so neither the id nor `prevMillis` changes.
 */
export const cronContextFromJob = (
  job: { id?: string, repeatJobKey?: string, opts?: { prevMillis?: number, repeat?: { pattern?: string, tz?: string } } },
): { tick: number, expression: string, tz: string } | undefined => {
  if (!job.repeatJobKey) return undefined

  const tick = job.opts?.prevMillis ?? tickFromJobId(job.id)
  if (tick === undefined) return undefined

  return {
    tick,
    expression: job.opts?.repeat?.pattern ?? '',
    tz: job.opts?.repeat?.tz ?? 'UTC',
  }
}
```

- [ ] **Step 4: Implement the `schedule` sub-object**

Add to the returned driver, after `introspect`:

```ts
    schedule: {
      upsert: async (queue, spec) => {
        await queueOf(queue).upsertJobScheduler(
          spec.id,
          { pattern: spec.expression, tz: spec.tz },
          // The job NAME must be the concierge job name, not the scheduler id:
          // `registerHandler` keys handlers by queue+name, so a scheduler
          // producing jobs under its own id would produce jobs no handler
          // matches — which fails on every tick, permanently, exactly like the
          // v1 defect this spec exists to not repeat.
          { name: spec.jobName, data: encodePayload(spec.payload) },
        )
      },

      list: async (queue) => {
        const found = await queueOf(queue).getJobSchedulers()
        return found.map(j => schedulerToSummary(j, queue))
      },

      remove: async (queue, id) => { await queueOf(queue).removeJobScheduler(id) },
    },
```

- [ ] **Step 5: Deliver `ctx.cron` in the worker**

In `consume`'s processor, add to the `handler({ ... })` call:

```ts
              cron: cronContextFromJob(job),
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/unit/drivers/bullmq-schedule.test.ts test/unit/drivers/bullmq-mapping.test.ts`
Expected: PASS.

Run: `pnpm typecheck:tests`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/drivers/bullmq.ts test/unit/drivers/bullmq-schedule.test.ts
git commit -m "feat(spec5): bullmq scheduling over job schedulers, with tick extraction"
```

---

## Task 9: The shared cron and dedup conformance table

**Files:**
- Modify: `test/unit/cron-dedup-conformance.test.ts`

**Interfaces:**
- Consumes: every driver's `schedule` and dedup behaviour (Tasks 5–8).
- Produces: nothing.

One shared table across `memory` and `bullmq`, never two independent files — that is how `depth()`
drifted in phase 1 and it is the convention every prior spec established. The bullmq half is
guarded on `REDIS_URL`, which CI supplies.

- [ ] **Step 1: Write the table**

**Keep every case Task 1 wrote in this file** — the `sync` absence assertion and the two
enqueue-result-shape cases are regression guards, not scaffolding. Add the driver table below them:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryDriver } from '../../src/runtime/server/drivers/memory'
import { createBullmqDriver } from '../../src/runtime/server/drivers/bullmq'
import { schedulerIdFor } from '../../src/runtime/server/cron'
import type { ConciergeDriver } from '../../src/runtime/server/drivers/types'

const REDIS_URL = process.env.REDIS_URL

/**
 * ONE table over both drivers, never two files. `depth()` drifted in phase 1
 * precisely because its two implementations were tested separately, and the
 * dedup semantics here are subtler than depth's: the lock/throttle difference
 * is one `PTTL` branch in BullMQ's Lua, and `memory` reimplements it by hand.
 */
const DRIVERS: Array<{ name: string, create: () => ConciergeDriver, skip: boolean }> = [
  { name: 'memory', create: () => createMemoryDriver(), skip: false },
  {
    name: 'bullmq',
    create: () => createBullmqDriver({ connection: { url: REDIS_URL } }),
    // Guarded, not silently degraded: without REDIS_URL this table would run
    // memory-only while still reporting green, which is exactly the shape of
    // "a test that exists, passes and proves nothing".
    skip: !REDIS_URL,
  },
]

for (const { name, create, skip } of DRIVERS) {
  describe.skipIf(skip)(`${name} driver — cron conformance`, () => {
    let driver: ConciergeDriver
    const queue = `conformance-cron-${name}`

    afterEach(async () => { await driver?.close(true) })

    it('upsert is idempotent', async () => {
      driver = create()
      await driver.init()
      const spec = { id: schedulerIdFor('a'), jobName: 'a', expression: '0 * * * *', tz: 'UTC' }
      await driver.schedule!.upsert(queue, spec)
      await driver.schedule!.upsert(queue, spec)

      const listed = (await driver.schedule!.list(queue))
        .filter(s => s.id === schedulerIdFor('a'))
      expect(listed).toHaveLength(1)
      await driver.schedule!.remove(queue, schedulerIdFor('a'))
    })

    it('upsert updates in place when the expression changes', async () => {
      driver = create()
      await driver.init()
      const base = { id: schedulerIdFor('b'), jobName: 'b', tz: 'UTC' }
      await driver.schedule!.upsert(queue, { ...base, expression: '0 * * * *' })
      await driver.schedule!.upsert(queue, { ...base, expression: '*/5 * * * *' })

      const listed = (await driver.schedule!.list(queue)).filter(s => s.id === schedulerIdFor('b'))
      // Both halves — one row AND the new expression. Either alone is
      // satisfied by an implementation that drops the second upsert.
      expect(listed).toHaveLength(1)
      expect(listed[0]!.expression).toBe('*/5 * * * *')
      await driver.schedule!.remove(queue, schedulerIdFor('b'))
    })

    it('remove deletes exactly the named schedule', async () => {
      driver = create()
      await driver.init()
      await driver.schedule!.upsert(queue, { id: schedulerIdFor('c'), jobName: 'c', expression: '0 * * * *', tz: 'UTC' })
      await driver.schedule!.upsert(queue, { id: schedulerIdFor('d'), jobName: 'd', expression: '0 * * * *', tz: 'UTC' })
      await driver.schedule!.remove(queue, schedulerIdFor('c'))

      const ids = (await driver.schedule!.list(queue)).map(s => s.id)
      expect(ids).not.toContain(schedulerIdFor('c'))
      // The second half: a `remove` that cleared everything would pass the
      // assertion above on its own.
      expect(ids).toContain(schedulerIdFor('d'))
      await driver.schedule!.remove(queue, schedulerIdFor('d'))
    })

    it('scopes schedules to their queue', async () => {
      driver = create()
      await driver.init()
      await driver.schedule!.upsert(`${queue}-a`, { id: schedulerIdFor('e'), jobName: 'e', expression: '0 * * * *', tz: 'UTC' })
      expect((await driver.schedule!.list(`${queue}-b`)).map(s => s.id)).not.toContain(schedulerIdFor('e'))
      await driver.schedule!.remove(`${queue}-a`, schedulerIdFor('e'))
    })
  })

  describe.skipIf(skip)(`${name} driver — dedup conformance`, () => {
    let driver: ConciergeDriver
    const queue = `conformance-dedup-${name}`

    afterEach(async () => { await driver?.close(true) })

    it('lock mode suppresses a second enqueue while the first is queued', async () => {
      driver = create()
      await driver.init()
      const id = `lock-${Date.now()}`
      const first = await driver.enqueue(queue, { name: 'j', payload: { n: 1 }, dedup: { id } })
      const second = await driver.enqueue(queue, { name: 'j', payload: { n: 2 }, dedup: { id } })

      expect(second.deduplicated).toBe(true)
      expect(second.id).toBe(first.id)
    })

    it('throttle mode suppresses within the window', async () => {
      driver = create()
      await driver.init()
      const id = `throttle-${Date.now()}`
      await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id, ttl: 60_000 } })
      const second = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id, ttl: 60_000 } })
      expect(second.deduplicated).toBe(true)
    })

    it('a distinct key is not suppressed', async () => {
      // The discriminating negative. Every case above passes for an
      // implementation that suppresses EVERY enqueue.
      driver = create()
      await driver.init()
      const stamp = Date.now()
      const a = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id: `x-${stamp}` } })
      const b = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id: `y-${stamp}` } })
      expect(b.deduplicated).toBe(false)
      expect(b.id).not.toBe(a.id)
    })

    it('no dedup option means no suppression', async () => {
      driver = create()
      await driver.init()
      const a = await driver.enqueue(queue, { name: 'j', payload: {} })
      const b = await driver.enqueue(queue, { name: 'j', payload: {} })
      expect(b.deduplicated).toBe(false)
      expect(b.id).not.toBe(a.id)
    })
  })
}
```

- [ ] **Step 2: Add the two subtlest cases to the table**

These are the behaviours the spec names as most likely to be got wrong, and testing them only in
`test/unit/drivers/memory-dedup.test.ts` would leave `bullmq` — the *reference* implementation —
unverified on exactly the two points where `memory` is reimplementing Lua by hand. Append inside
the dedup `describe` block:

```ts
    it('debounce collapses a burst onto one job', async () => {
      driver = create()
      await driver.init()
      const id = `debounce-${Date.now()}`
      const dedup = { id, ttl: 60_000, extend: true, replace: true }
      // A long delay so every enqueue lands while the previous one is still
      // pending — `replace` only supersedes a job that has not started.
      const opts = { name: 'j', dedup, delay: 30_000 }

      await driver.enqueue(queue, { ...opts, payload: { n: 1 } })
      await driver.enqueue(queue, { ...opts, payload: { n: 2 } })
      await driver.enqueue(queue, { ...opts, payload: { n: 3 } })

      const counts = await driver.introspect!.counts(queue)
      // One job for three enqueues. Under THROTTLE this is also 1, which is
      // why the payload assertion below is the one that discriminates.
      expect(counts.delayed).toBe(1)
    })

    it('lock mode does NOT release on an intermediate failure', async () => {
      // Retries move a job through moveToDelayed/retryJob, never
      // moveToFinished, so a job with attempts: 3 holds its key across all
      // three. An implementation that releases on every caught error lets a
      // duplicate in mid-retry — and every other case in this table still
      // passes. Verified against
      // bullmq/dist/esm/scripts/moveToFinished-14.js:606-621.
      driver = create()
      await driver.init()
      const id = `midretry-${Date.now()}`
      driver.registerHandler(queue, 'j', async () => { throw new Error('boom') })
      driver.consume(queue, { concurrency: 1 })

      await driver.enqueue(queue, {
        name: 'j', payload: {}, dedup: { id }, attempts: 3,
        backoff: { type: 'fixed', delay: 30_000 },
      })
      await new Promise(r => setTimeout(r, 500))

      const dup = await driver.enqueue(queue, { name: 'j', payload: {}, dedup: { id } })
      expect(dup.deduplicated).toBe(true)
    })
```

- [ ] **Step 3: Run against memory only**

Run: `pnpm vitest run test/unit/cron-dedup-conformance.test.ts`
Expected: PASS, with the bullmq blocks reported as skipped.

- [ ] **Step 4: Run against real Redis**

Run: `REDIS_URL=redis://localhost:6379 pnpm vitest run test/unit/cron-dedup-conformance.test.ts`
Expected: PASS, with no skips. If Redis is unavailable locally, start one:
`docker run --rm -p 6379:6379 redis:7`.

- [ ] **Step 5: Prove the table can fail**

Two separate mutations, because one driver going red proves nothing about the other:

1. Change `memory.ts`'s `liveDedup` to always return `undefined`. Re-run with `REDIS_URL` set.
   Expect the `memory` lock, throttle, debounce and mid-retry cases red, and the whole `bullmq`
   half green.
2. Revert, then change `bullmqAddOptions` to drop `deduplication`. Re-run. Expect the mirror
   image.

Revert both. A conformance table nobody has watched fail on each side is not evidence of
conformance — it is two implementations agreeing that they were never asked anything.

- [ ] **Step 6: Commit**

```bash
git add test/unit/cron-dedup-conformance.test.ts
git commit -m "test(spec5): shared cron and dedup conformance table across drivers"
```

---

## Task 10: Supervisor — boot reconciliation and registry wiring

**Files:**
- Modify: `src/runtime/server/supervisor.ts`
- Modify: `src/runtime/server/cron.ts` (append `reconcileSchedules`)
- Test: `test/unit/supervisor.test.ts`
- Test: `test/unit/cron.test.ts`

**Interfaces:**
- Consumes: `planReconciliation`, `schedulerIdFor`, `validateCronPayloads` (Tasks 3–4);
  `DriverScheduling` (Task 1).
- Produces: `RegistryEntry.unique`/`uniqueId`; `reconcileSchedules(args: { driver, jobs, queues,
  enabled }): Promise<void>`; `SupervisorConfig.cron`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/cron.test.ts`:

```ts
import { reconcileSchedules } from '../../src/runtime/server/cron'

const fakeScheduler = (existing: string[] = []) => {
  const calls = { upserts: [] as string[], removals: [] as string[] }
  return {
    calls,
    schedule: {
      upsert: async (_q: string, spec: { id: string }) => { calls.upserts.push(spec.id) },
      list: async (queue: string) => existing.map(id => ({
        id, jobName: 'x', queue, expression: '0 * * * *', tz: 'UTC',
      })),
      remove: async (_q: string, id: string) => { calls.removals.push(id) },
    },
  }
}

describe('reconcileSchedules', () => {
  it('upserts declared schedules and prunes undeclared ones', async () => {
    const fake = fakeScheduler([schedulerIdFor('gone')])
    await reconcileSchedules({
      schedule: fake.schedule,
      jobs: [{ name: 'live', queue: 'default', cron: { expression: '0 * * * *', tz: 'UTC' } }],
      queues: ['default'],
      enabled: true,
    })
    expect(fake.calls.upserts).toEqual([schedulerIdFor('live')])
    expect(fake.calls.removals).toEqual([schedulerIdFor('gone')])
  })

  it('prunes everything and upserts nothing when disabled', async () => {
    const fake = fakeScheduler([schedulerIdFor('live')])
    await reconcileSchedules({
      schedule: fake.schedule,
      jobs: [{ name: 'live', queue: 'default', cron: { expression: '0 * * * *', tz: 'UTC' } }],
      queues: ['default'],
      enabled: false,
    })
    // Both halves. "No upserts" alone is satisfied by an implementation that
    // skips reconciliation entirely — which is precisely the behaviour this
    // option must NOT have, because it would leave stale schedulers producing
    // jobs against a deployment that believes cron is off.
    expect(fake.calls.upserts).toEqual([])
    expect(fake.calls.removals).toEqual([schedulerIdFor('live')])
  })

  it('only considers jobs targeting the queue being reconciled', async () => {
    const fake = fakeScheduler()
    await reconcileSchedules({
      schedule: fake.schedule,
      jobs: [
        { name: 'a', queue: 'default', cron: { expression: '0 * * * *', tz: 'UTC' } },
        { name: 'b', queue: 'other', cron: { expression: '0 * * * *', tz: 'UTC' } },
      ],
      queues: ['default'],
      enabled: true,
    })
    expect(fake.calls.upserts).toEqual([schedulerIdFor('a')])
  })

  it('ignores jobs with no cron', async () => {
    const fake = fakeScheduler()
    await reconcileSchedules({
      schedule: fake.schedule,
      jobs: [{ name: 'plain', queue: 'default' }],
      queues: ['default'],
      enabled: true,
    })
    expect(fake.calls.upserts).toEqual([])
  })
})
```

Append to `test/unit/supervisor.test.ts`:

```ts
describe('supervisor cron reconciliation', () => {
  it('reconciles at boot on a worker', async () => {
    const job = defineJob({ name: 'digest', cron: '0 * * * *', handler: async () => {} })
    const s = await createSupervisor(baseConfig({ role: 'worker', jobs: [job] }))
    await s.startConsumers()

    expect((await s.driver.schedule!.list('default')).map(x => x.jobName)).toEqual(['digest'])
    await s.stop()
  })

  it('does NOT reconcile on a web-role instance', async () => {
    // Cron produces work; workers own work. A web instance writing schedules
    // for queues it does not consume is how a deployment ends up with
    // schedules nobody runs.
    const job = defineJob({ name: 'digest', cron: '0 * * * *', handler: async () => {} })
    const s = await createSupervisor(baseConfig({ role: 'web', jobs: [job] }))
    await s.startConsumers()

    expect(await s.driver.schedule!.list('default')).toEqual([])
    await s.stop()
  })

  it('throws at boot when a cron payload violates its own schema', async () => {
    const job = defineJob({
      name: 'digest',
      input: z.object({ scope: z.string() }),
      cron: { expression: '0 * * * *', payload: { scope: 1 } },
      handler: async () => {},
    })
    await expect(createSupervisor(baseConfig({ role: 'worker', jobs: [job] })))
      .rejects.toThrow(/digest/)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run test/unit/cron.test.ts test/unit/supervisor.test.ts`
Expected: FAIL — `reconcileSchedules` is not exported, and the supervisor neither reconciles nor
validates.

- [ ] **Step 3: Add `reconcileSchedules`**

Append to `src/runtime/server/cron.ts`:

```ts
import type { DriverScheduling } from './drivers/types'

export interface ReconcileArgs {
  schedule: DriverScheduling
  /** Every scanned job. The full set, never this instance's subset. */
  jobs: Array<{ name: string, queue: string, cron?: CronSpec }>
  /** The queues this instance declares. */
  queues: string[]
  enabled: boolean
}

/**
 * Upsert every declared schedule, then remove every concierge-owned scheduler
 * that is no longer declared — per queue, at boot, with no coordination
 * between instances.
 *
 * No leader election is needed because tick-uniqueness is a DRIVER guarantee:
 * `bullmq` keeps one delayed job in flight per scheduler, atomically in Lua,
 * and `memory` is single-process. A leader would be solving that problem a
 * second time.
 *
 * The accepted cost: during a rolling deploy that changes or removes a `cron`
 * key, old and new code disagree for the deploy window, so a schedule can miss
 * at most ONE tick. The prune is idempotent and convergent — a wrong prune
 * self-heals on the next boot.
 *
 * The declared set is computed from the FULL scanned job list, not from the
 * jobs this instance happens to handle. An instance whose `worker.queues` has
 * been narrowed sweeps only its own queues, which is self-consistent — but it
 * means at least one running instance must declare the full queue set, or
 * schedules on the undeclared queues are never reconciled at all.
 */
export const reconcileSchedules = async (
  { schedule, jobs, queues, enabled }: ReconcileArgs,
): Promise<void> => {
  for (const queue of queues) {
    const declared: ScheduleSpec[] = enabled
      ? jobs
          .filter(job => job.cron && job.queue === queue)
          .map(job => ({
            id: schedulerIdFor(job.name),
            jobName: job.name,
            expression: job.cron!.expression,
            tz: job.cron!.tz,
            payload: job.cron!.payload,
          }))
      // Disabled runs the sweep with an EMPTY declared set rather than
      // skipping it, so "off" means off in Redis rather than merely off in
      // this process.
      : []

    const { upserts, removals } = planReconciliation({
      declared,
      existing: await schedule.list(queue),
    })

    for (const spec of upserts) await schedule.upsert(queue, spec)
    for (const id of removals) await schedule.remove(queue, id)
  }
}
```

- [ ] **Step 4: Wire the supervisor**

In `src/runtime/server/supervisor.ts`:

Add `unique?: UniqueOptions` and `uniqueId?: (payload: never) => string` to `RegistryEntry`, and
populate both in the `registry` construction alongside `attempts`/`backoff`.

Add `cron: CronOptions` to `SupervisorConfig`.

After the undeclared-queue loop in `createSupervisor`, add:

```ts
  // Boot-time, because validation must EXECUTE the schema and build time
  // cannot. A schema-violating cron payload otherwise dead-letters on every
  // tick forever, since payload failures are permanent by design.
  await validateCronPayloads(config.jobs)
```

Inside `startConsumers`, in the `config.role !== 'web'` branch, after consumers are created and
before the heartbeat is armed:

```ts
        if (driver.schedule) {
          try {
            await reconcileSchedules({
              schedule: driver.schedule,
              jobs: config.jobs,
              queues: queueNames,
              enabled: config.cron.enabled,
            })
          }
          catch (error) {
            // Logged, not fatal. A worker that cannot reach Redis to reconcile
            // must still come up and process whatever it can — the alternative
            // is a deploy that refuses to start because of a transient blip,
            // and reconciliation is convergent: the next boot fixes it.
            logger.warn('[nuxt-concierge] schedule reconciliation failed', error)
          }
        }
        else if (config.jobs.some(job => job.cron)) {
          logger.warn(
            `[nuxt-concierge] the "${driver.name}" driver cannot schedule, so `
            + `${config.jobs.filter(job => job.cron).length} cron job(s) will never fire.`,
          )
        }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/unit/cron.test.ts test/unit/supervisor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/server/cron.ts src/runtime/server/supervisor.ts \
  test/unit/cron.test.ts test/unit/supervisor.test.ts
git commit -m "feat(spec5): boot-time schedule reconciliation in the supervisor"
```

---

## Task 11: `useQueue` — dedup resolution and the new enqueue result

**Files:**
- Modify: `src/runtime/server/utils/useQueue.ts`
- Test: `test/unit/useQueue.test.ts`
- Test: `test/types/enqueue.test-d.ts`

**Interfaces:**
- Consumes: `resolveDedup` (Task 2), `RegistryEntry.unique`/`uniqueId` (Task 10).
- Produces: `TypedQueue.enqueue` returning `Promise<EnqueueResult>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/useQueue.test.ts`:

Follow the file's existing pattern exactly — `baseConfig(...)` + `createSupervisor` + `vi.spyOn(supervisor.driver, 'enqueue')`, with the `afterEach(resetSupervisor)` already at the top of the file. There is no `harness()` helper in this repo; do not invent one.

```ts
describe('useQueue deduplication', () => {
  it('passes no dedup option for a job that declares none', async () => {
    const job = defineJob({ name: 'plain', handler: () => {} })
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('plain', {})

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({ dedup: undefined }))
  })

  it('resolves lock mode to an id with no ttl', async () => {
    const job = defineJob({ name: 'u', unique: true, handler: () => {} })
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('u', { a: 1 })

    expect(spy.mock.calls[0]![1].dedup).toEqual({ id: expect.any(String) })
  })

  it("uses the job's uniqueId, namespaced by job name", async () => {
    const job = defineJob<{ id: number }>({
      name: 'invoice',
      unique: true,
      uniqueId: p => `i:${p.id}`,
      handler: () => {},
    })
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('invoice', { id: 7 })

    expect(spy.mock.calls[0]![1].dedup!.id).toBe('invoice:i:7')
  })

  it('derives the key from the RAW payload, before any transform', async () => {
    // uniqueId runs on the producer alongside validateOnEnqueue, whose result
    // is discarded — so the key must come from what the caller passed, not
    // from a transformed value that only exists in the worker. `n` is a string
    // here and a number after the transform, so a key of "t:n:5" proves the
    // raw side and "t:n:5" from a transformed payload would read the same —
    // which is why the assertion below also checks the payload handed to the
    // driver is still the raw one.
    const job = defineJob({
      name: 't',
      input: z.object({ n: z.string().transform(Number) }),
      unique: true,
      uniqueId: p => `n:${p.n}`,
      handler: () => {},
    })
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('t', { n: '5' })

    expect(spy.mock.calls[0]![1].dedup!.id).toBe('t:n:5')
    // Both halves: the transform must not have been applied to what was
    // enqueued either, which is spec 3's transform-once invariant.
    expect(spy.mock.calls[0]![1].payload).toEqual({ n: '5' })
  })

  it('returns the driver deduplicated flag to the caller', async () => {
    const job = defineJob({ name: 'u', unique: true, handler: () => {} })
    const supervisor = await createSupervisor(baseConfig([job]))
    vi.spyOn(supervisor.driver, 'enqueue').mockResolvedValue({ id: 'existing', deduplicated: true })

    await expect(useQueue().enqueue('u', {})).resolves.toEqual({ id: 'existing', deduplicated: true })
  })
})
```

Append to `test/types/enqueue.test-d.ts`:

```ts
// The return type is the deliverable here: a runtime test passes whether or
// not `deduplicated` is typed, because a spy accepts any shape.
expectTypeOf(useQueue().enqueue).returns.resolves.toEqualTypeOf<{ id: string, deduplicated: boolean }>()
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run test/unit/useQueue.test.ts && pnpm test:types`
Expected: FAIL — `dedup` is never passed, and the declared return type is `{ id: string }`.

- [ ] **Step 3: Implement**

Rewrite the relevant part of `src/runtime/server/utils/useQueue.ts`:

```ts
import { resolveDedup } from '../dedup'
import type { EnqueueResult } from '../drivers/types'

export interface TypedQueue<Map> {
  enqueue: <K extends keyof Map>(
    name: K,
    payload: Map[K],
    opts?: EnqueueJobOptions,
  ) => Promise<EnqueueResult>
}
```

and inside `enqueue`, after the existing `validateOnEnqueue` call:

```ts
    return driver.enqueue(entry.queue, {
      name: String(name),
      payload,
      delay: opts.delay,
      attempts: entry.attempts ?? defaults.attempts,
      backoff: entry.backoff ?? defaults.backoff,
      // Derived from the RAW payload, deliberately. `validateOnEnqueue`
      // discards its result so a transforming schema runs exactly once — in
      // the worker — which means the transformed value does not exist here and
      // the key must come from what the caller actually passed.
      dedup: resolveDedup({
        jobName: String(name),
        payload,
        unique: entry.unique,
        uniqueId: entry.uniqueId,
      }),
    })
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/unit/useQueue.test.ts && pnpm test:types && pnpm typecheck:public`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/server/utils/useQueue.ts test/unit/useQueue.test.ts test/types/enqueue.test-d.ts
git commit -m "feat(spec5): resolve dedup at enqueue and return the deduplicated flag"
```

---

## Task 12: The schedules API

**Files:**
- Create: `src/runtime/server/routes/api/schedules-list.ts`
- Create: `src/runtime/server/routes/api/schedules-run.ts`
- Modify: `src/runtime/server/introspect.ts`
- Modify: `src/module.ts:99-109`
- Test: `test/unit/api/schedules.test.ts`
- Test: `test/unit/api/overview.test.ts`

**Interfaces:**
- Consumes: `DriverScheduling`, `withTimeoutOrThrow`, `DriverReadTimeoutError`.
- Produces: `OverviewResponse.schedulable`, `readSchedules(schedule, driverName, queue, timeoutMs)`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/api/schedules.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { DriverReadTimeoutError, readSchedules } from '../../../src/runtime/server/introspect'

describe('readSchedules', () => {
  it('returns the driver list', async () => {
    const schedule = { list: vi.fn().mockResolvedValue([{ id: 'a' }]), upsert: vi.fn(), remove: vi.fn() }
    await expect(readSchedules(schedule, 'memory', 'default')).resolves.toEqual([{ id: 'a' }])
  })

  it('throws DriverReadTimeoutError when the driver hangs', async () => {
    // A dead-Redis command never rejects — it sits in ioredis's offline queue
    // and never settles at all, because BullMQ requires
    // `maxRetriesPerRequest: null`. Without this bound the Schedules panel
    // hangs forever instead of showing the unhealthy state.
    const schedule = { list: vi.fn(() => new Promise(() => {})), upsert: vi.fn(), remove: vi.fn() }
    await expect(readSchedules(schedule, 'bullmq', 'default', 10))
      .rejects.toBeInstanceOf(DriverReadTimeoutError)
  })

  it('names the driver and the bound in the timeout message', async () => {
    const schedule = { list: vi.fn(() => new Promise(() => {})), upsert: vi.fn(), remove: vi.fn() }
    await expect(readSchedules(schedule, 'bullmq', 'default', 10))
      .rejects.toThrow(/bullmq driver did not respond within 10ms/)
  })
})
```

In `test/unit/api/overview.test.ts`, extend the existing `fakeSupervisor` helper — there is no
`supervisorWith()` in this repo; do not invent one. Add `schedulable: boolean` to its `Partial<...>`
option type and this to the `driver` object it builds:

```ts
    // Presence IS the capability, mirroring how `introspect` is faked above.
    schedule: (over.schedulable ?? true)
      ? {
          upsert: async () => {},
          list: async () => [],
          remove: async () => {},
        }
      : undefined,
```

Then append the cases:

```ts
describe('buildOverview schedulable flag', () => {
  it('is true for a driver that declares scheduling', async () => {
    expect((await buildOverview(fakeSupervisor())).schedulable).toBe(true)
  })

  it('is false for a driver that does not', async () => {
    // `sync` has no `schedule` at all, and an empty schedule list from such a
    // driver is indistinguishable from a codebase with no cron jobs — which is
    // exactly the confident-empty-table lie the flag exists to prevent.
    expect((await buildOverview(fakeSupervisor({ schedulable: false }))).schedulable).toBe(false)
  })

  it('is false when there is no supervisor at all', async () => {
    expect((await buildOverview(undefined)).schedulable).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run test/unit/api/schedules.test.ts test/unit/api/overview.test.ts`
Expected: FAIL — `readSchedules` is not exported and `schedulable` is `undefined`.

- [ ] **Step 3: Extend `introspect.ts`**

Add `schedulable: boolean` to `OverviewResponse` with this comment:

```ts
  /**
   * Whether the driver can schedule at all. Presence is the capability, and
   * the panel needs this to EXPLAIN an empty list rather than render one — an
   * empty list from `sync` means "this driver cannot schedule", not "you have
   * no cron jobs".
   */
  schedulable: boolean
```

Set `schedulable: false` in the no-supervisor early return and
`schedulable: Boolean(driver.schedule)` in the main return. Then append the bounded read:

```ts
/**
 * Bounded for the identical reason as the jobs routes: `schedule.list()` calls
 * straight into the driver with nothing stopping a dead-Redis connection from
 * queueing the command forever. Found twice in spec 4 over the same cause, on
 * the same connection — a new route is a new instance of the same bug.
 */
export const readSchedules = (
  schedule: DriverScheduling,
  driverName: string,
  queue: string,
  timeoutMs: number = DRIVER_READ_TIMEOUT_MS,
): Promise<ScheduleSummary[]> =>
  withTimeoutOrThrow(schedule.list(queue), timeoutMs, driverTimeoutMessage(driverName, timeoutMs))
```

- [ ] **Step 4: Write the list route**

Create `src/runtime/server/routes/api/schedules-list.ts`:

```ts
import { defineEventHandler, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { DriverReadTimeoutError, readSchedules } from '../../introspect'

/**
 * Registered only under nuxt.options.dev (see src/module.ts), so this file is
 * never part of a production bundle and needs no auth check of its own.
 *
 * Unpaginated, deliberately: schedules are declared in source, so their count
 * is bounded by the size of the codebase rather than by traffic. That is the
 * opposite of the jobs list, whose MAX_LIMIT exists for a real reason.
 */
export default defineEventHandler(async (event) => {
  const supervisor = getSupervisor()
  if (!supervisor?.driver.schedule) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support scheduling' }
  }
  const schedule = supervisor.driver.schedule

  try {
    const queues = Object.keys(supervisor.config.worker.queues)
    const perQueue = await Promise.all(
      queues.map(queue => readSchedules(schedule, supervisor.driver.name, queue)),
    )
    return { items: perQueue.flat() }
  }
  catch (error) {
    if (error instanceof DriverReadTimeoutError) {
      setResponseStatus(event, 503)
      return { error: error.message }
    }
    setResponseStatus(event, 500)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
```

- [ ] **Step 5: Write the run-now route**

Create `src/runtime/server/routes/api/schedules-run.ts`:

```ts
import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { useQueue } from '../../utils/useQueue'

/**
 * Dev-only, and a WRITE — which needs no new security argument, because the
 * retry route already established that the dev dashboard performs writes and
 * spec 4's registration-time gating covers both unchanged.
 *
 * Enqueues through `useQueue` rather than the driver directly, so the job goes
 * through the same validation, retry-option resolution and deduplication as a
 * real enqueue. A run-now that bypassed those would be testing a code path no
 * production tick uses.
 */
export default defineEventHandler(async (event) => {
  const supervisor = getSupervisor()
  if (!supervisor) {
    setResponseStatus(event, 503)
    return { error: 'the supervisor has not started yet' }
  }

  const name = getRouterParam(event, 'name')
  const job = supervisor.config.jobs.find(j => j.name === name)
  if (!job?.cron) {
    setResponseStatus(event, 404)
    return { error: `no scheduled job named "${name}"` }
  }

  try {
    const result = await useQueue().enqueue(job.name, job.cron.payload)
    setResponseStatus(event, 202)
    return result
  }
  catch (error) {
    // 409 with the driver's own message, matching the retry route: a dedup
    // suppression or a validation failure both name their own cause, and
    // swallowing that into a generic 500 renders as "run failed" with no reason.
    setResponseStatus(event, 409)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
```

- [ ] **Step 6: Register both routes**

In `src/module.ts`, add to `API_HANDLERS`:

```ts
        "/_concierge/api/schedules": { handler: "./runtime/server/routes/api/schedules-list", method: "get" },
        "/_concierge/api/schedules/:name/run": { handler: "./runtime/server/routes/api/schedules-run", method: "post" },
```

`post` on the run route for the same reason `jobs-retry` uses it: a dev server is reachable from
any page a developer happens to visit, and without a method constraint a bare `GET` would fire the
job.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run test/unit/api/ && pnpm typecheck:tests`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/server/routes/api/schedules-*.ts src/runtime/server/introspect.ts \
  src/module.ts test/unit/api/
git commit -m "feat(spec5): schedules API with bounded reads and run-now"
```

---

## Task 13: The Schedules panel

**Files:**
- Create: `client/src/panels/SchedulesPanel.vue`
- Modify: `client/src/api.ts`
- Modify: `client/src/types.ts`
- Modify: `client/src/App.vue`
- Test: `test/unit/client-build.test.ts`

**Interfaces:**
- Consumes: `GET /_concierge/api/schedules`, `POST /_concierge/api/schedules/:name/run`,
  `Overview.schedulable` (Task 12).
- Produces: nothing consumed by later tasks.

The SPA holds no business logic — every derived state is computed server-side and sent as a flag.
That is the sole reason this project ships no client-side component tests, and it must stay true
here: the panel renders `schedulable` and formats timestamps, and derives nothing else.

- [ ] **Step 1: Extend the client types and API**

In `client/src/types.ts`, add to `Overview`:

```ts
  /** Whether the driver can schedule at all. Computed server-side. */
  schedulable: boolean
```

In `client/src/api.ts`, add the view type and both calls:

```ts
export interface ScheduleView {
  id: string
  jobName: string
  queue: string
  expression: string
  tz: string
  next?: number
  iterationCount?: number
}
```

```ts
  schedules: () => json<{ items: ScheduleView[] }>('/_concierge/api/schedules'),
  runSchedule: async (name: string) => {
    const res = await fetch(
      `/_concierge/api/schedules/${encodeURIComponent(name)}/run`,
      { method: 'POST' },
    )
    if (res.ok) return res.json() as Promise<{ id: string, deduplicated: boolean }>
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `run failed with ${res.status}`)
  },
```

- [ ] **Step 2: Write the panel**

Create `client/src/panels/SchedulesPanel.vue`:

```vue
<script lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'
import type { ScheduleView } from '../api'
import type { Overview } from '../types'

interface Props {
  overview: Overview
}
</script>

<script setup lang="ts">
const { overview } = defineProps<Props>()

const schedules = ref<ScheduleView[]>([])
const error = ref<string | undefined>()
const notice = ref<string | undefined>()

const load = async () => {
  if (!overview.schedulable) return
  try {
    schedules.value = (await api.schedules()).items
    error.value = undefined
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

const run = async (jobName: string) => {
  try {
    const result = await api.runSchedule(jobName)
    // The deduplicated flag is surfaced, not swallowed. A run-now that
    // silently did nothing because a dedup key was held is exactly the
    // "why didn't my job run?" case the flag exists to answer.
    notice.value = result.deduplicated
      ? `"${jobName}" was deduplicated — an identical job is already queued or running.`
      : `"${jobName}" enqueued as ${result.id}.`
    await load()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

const formatTime = (ms?: number) => (ms === undefined ? '—' : new Date(ms).toLocaleString())

onMounted(load)
</script>

<template>
  <div class="space-y-3">
    <UAlert
      v-if="!overview.schedulable"
      color="neutral"
      variant="subtle"
      icon="i-lucide-calendar-off"
      title="This driver cannot schedule"
      :description="`The ${overview.driver} driver does not implement scheduling, so no cron job will fire.`"
    />
    <template v-else>
      <UAlert v-if="error" color="error" title="Cannot read schedules" :description="error" />
      <UAlert v-if="notice" color="neutral" variant="subtle" :description="notice" />

      <p v-if="!schedules.length && !error" class="text-sm text-muted">
        No cron jobs are declared. Add <code>cron</code> to a job in <code>server/jobs/</code>.
      </p>

      <UTable
        v-else-if="schedules.length"
        :data="schedules"
        :columns="[
          { accessorKey: 'jobName', header: 'Job' },
          { accessorKey: 'queue', header: 'Queue' },
          { accessorKey: 'expression', header: 'Schedule' },
          { accessorKey: 'tz', header: 'Timezone' },
          { accessorKey: 'next', header: 'Next run' },
          { accessorKey: 'iterationCount', header: 'Ticks' },
          { id: 'actions', header: '' },
        ]"
      >
        <template #next-cell="{ row }">
          {{ formatTime(row.original.next) }}
        </template>
        <template #iterationCount-cell="{ row }">
          {{ row.original.iterationCount ?? '—' }}
        </template>
        <template #actions-cell="{ row }">
          <UButton size="xs" variant="ghost" icon="i-lucide-play" @click="run(row.original.jobName)">
            Run now
          </UButton>
        </template>
      </UTable>
    </template>
  </div>
</template>
```

- [ ] **Step 3: Add the tab**

In `client/src/App.vue`, add `{ label: 'Schedules', slot: 'schedules' }` to the `UTabs` items
between Jobs and Registry, add the import, and add the template slot:

```vue
      <template #schedules>
        <SchedulesPanel :overview="overview" />
      </template>
```

- [ ] **Step 4: Extend the build assertion**

Append to `test/unit/client-build.test.ts` a case asserting the built SPA contains the Schedules
tab label, so a panel that fails to be bundled is caught:

```ts
it('bundles the Schedules panel', () => {
  // The build-order landmine from spec 4 produces no error of its own — the
  // only symptom is a missing directory in a tarball nobody inspects. This
  // asserts the new panel actually reached the bundle.
  const assets = readdirSync(resolve('dist/client/assets'))
  const js = assets.filter(f => f.endsWith('.js'))
    .map(f => readFileSync(resolve('dist/client/assets', f), 'utf8'))
    .join('')
  expect(js).toContain('Schedules')
})
```

- [ ] **Step 5: Build and check**

Run: `pnpm build:client && pnpm typecheck:client && pnpm vitest run test/unit/client-build.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify by eye**

Run: `pnpm dev`, open the Concierge tab in Nuxt DevTools, and confirm the Schedules tab lists the
playground's cron job with a next-run time, and that Run now reports either an id or a
deduplication notice.

- [ ] **Step 7: Commit**

```bash
git add client/ test/unit/client-build.test.ts
git commit -m "feat(spec5): Schedules panel with run-now in the dev dashboard"
```

---

## Task 14: Lifecycle coverage, docs and close-out

**Files:**
- Create: `test/lifecycle/cron.test.ts`
- Modify: `playground/server/jobs/` (add a cron job fixture)
- Modify: `README.md`
- Modify: `specs/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Add the playground fixture**

Create `playground/server/jobs/heartbeat-digest.ts`:

```ts
export default defineJob({
  // Every minute, so a dev session or a lifecycle run actually sees it fire.
  cron: '* * * * *',
  handler: async (ctx) => {
    console.log(`[digest] tick ${ctx.cron?.tick} (${ctx.cron?.tz})`)
  },
})
```

- [ ] **Step 2: Write the lifecycle scenario**

Create `test/lifecycle/cron.test.ts`, following the existing harness conventions in
`test/lifecycle/harness.ts` (readiness by polling the health endpoint, never fixed sleeps):

```ts
import { describe, expect, it } from 'vitest'
import { startApp, stopApp } from './harness'

/**
 * The case that would justify leader election if it failed. Two worker
 * processes boot concurrently against one Redis; both reconcile with no
 * coordination. If BullMQ's one-delayed-job-per-scheduler guarantee did not
 * hold, this produces two schedulers and two runs per tick.
 */
describe('cron across two workers', () => {
  it('produces exactly one scheduler and bounded runs per tick', async () => {
    const a = await startApp({ role: 'worker' })
    const b = await startApp({ role: 'worker' })

    try {
      const schedulers = await a.listSchedulers('default')
      expect(schedulers.filter(s => s.jobName === 'heartbeat-digest')).toHaveLength(1)

      const runs = await a.countRunsOverTicks('heartbeat-digest', 2)
      // Counted and BOUNDED, never asserted to be exactly N. Delivery is
      // at-least-once, so a redelivery is legal — but asserting nothing would
      // let a driver that fires on every instance pass.
      expect(runs).toBeGreaterThanOrEqual(2)
      expect(runs).toBeLessThanOrEqual(3)
    }
    finally {
      await stopApp(a)
      await stopApp(b)
    }
  })

  it('prunes a schedule that is no longer declared', async () => {
    const app = await startApp({ role: 'worker' })
    try {
      await app.injectOrphanScheduler('default', 'concierge:deleted-job')
      await app.restart()
      const ids = (await app.listSchedulers('default')).map(s => s.id)
      expect(ids).not.toContain('concierge:deleted-job')
      // The second half: a prune that removed everything would pass above.
      expect(ids).toContain('concierge:heartbeat-digest')
    }
    finally {
      await stopApp(app)
    }
  })

  it('leaves a foreign scheduler on the same queue untouched', async () => {
    // Adopting concierge on a queue that already carries unrelated BullMQ
    // repeatable jobs must not delete them. Covered as a unit in
    // planReconciliation, but asserted end-to-end because the ownership filter
    // is the only thing standing between a first boot and someone else's
    // schedules.
    const app = await startApp({ role: 'worker' })
    try {
      await app.injectOrphanScheduler('default', 'someone-elses-scheduler')
      await app.restart()
      expect((await app.listSchedulers('default')).map(s => s.id))
        .toContain('someone-elses-scheduler')
    }
    finally {
      await stopApp(app)
    }
  })

  it('reports the same tick across a retry of that tick', async () => {
    // ctx.cron.tick is the SCHEDULED time, and its stability across a retry is
    // the entire reason it is offered as an idempotency key. A handler that
    // saw Date.now() would get a different value on every attempt, which is
    // precisely the thing that makes an idempotency key useless — and no unit
    // test can observe it, because the retry has to be real.
    const app = await startApp({ role: 'worker', failFirstAttempt: 'heartbeat-digest' })
    try {
      const ticks = await app.collectTicks('heartbeat-digest', { attempts: 2 })
      expect(ticks).toHaveLength(2)
      expect(ticks[0]).toBe(ticks[1])
      // Both halves: two equal values also satisfy "the handler never ran and
      // both are undefined".
      expect(ticks[0]).toEqual(expect.any(Number))
    }
    finally {
      await stopApp(app)
    }
  })
})
```

Extend `test/lifecycle/harness.ts` with `listSchedulers`, `countRunsOverTicks`,
`injectOrphanScheduler`, `collectTicks`, `restart` and the `failFirstAttempt` start option,
implemented against the real built output and a real Redis in the same style as the existing
helpers. Readiness comes from polling the health endpoint, never from fixed sleeps.

> `test/lifecycle/globalSetup.ts` already builds the playground once for the whole project (#21),
> so adding this file costs one more scenario rather than one more full build.

- [ ] **Step 3: Observe the scenario failing against the broken behaviour**

Temporarily change `reconcileSchedules` to skip its removals loop, run the second case, and confirm
it goes red. Revert. Per the phase 1 convention, a lifecycle scenario counts only once it has been
seen failing against the behaviour it guards.

Run: `REDIS_URL=redis://localhost:6379 pnpm test:lifecycle`
Expected: PASS after reverting.

- [ ] **Step 4: Document both features**

In `README.md`, replace the "Cron is not in this release" note with cron and dedup sections
covering: the string and object `cron` forms; the **UTC default** and why it is not system-local;
`concierge.cron.enabled` as a **deployment-wide** switch that prunes when disabled; `ctx.cron.tick`
as an idempotency key; the three `unique` modes with what each guarantees; and the two honesty
statements the spec requires, in these words:

> **This deduplicates enqueues. It never serializes execution.** `cron` plus `unique` gives you
> "no more than one *queued* at a time", which is not "no more than one *running* at a time".
>
> To reduce overlap, give the job a dedicated queue with concurrency 1. Note the limit:
> BullMQ's concurrency is per worker *instance*, so two worker processes at concurrency 1 give
> you two concurrent runs.

Also document that **a missed window produces at most one catch-up run**, never a backfill.

- [ ] **Step 5: Update the roadmap**

In `specs/README.md`, move spec 5 to **Implemented** with a link to this plan.

- [ ] **Step 6: Run everything**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm typecheck:public && pnpm typecheck:tests \
  && pnpm typecheck:client && pnpm test:types \
  && REDIS_URL=redis://localhost:6379 pnpm test \
  && REDIS_URL=redis://localhost:6379 pnpm test:lifecycle
```
Expected: all PASS. `REDIS_URL` is required or the conformance table silently degrades to
memory-only — the one place it is automated.

- [ ] **Step 7: Verify the tarball**

Run: `pnpm prepack && npm pack --dry-run | grep -q dist/client && echo OK`
Expected: `OK`. The build-order landmine produces no error of its own; only an assertion on the
built tarball catches a regression.

- [ ] **Step 8: Commit**

```bash
git add test/lifecycle/ playground/ README.md specs/README.md
git commit -m "feat(spec5): cron lifecycle coverage and documentation"
```

---

## After the plan

Write a **spec 5 decisions record** at `specs/2026-08-14-spec5-decisions.md`, in the same shape as
the phase 1, spec 3 and spec 4 records: constraints that break the build or silently break
behaviour, corrections to earlier claims, known gaps deliberately carried with their issue numbers,
facts that cost real time, and test-suite conventions established. All three prior records proved
to be the highest-value artifact of their spec, and several items in this plan exist only because
those records recorded them.

Four things already known to belong in it:

- **`import { parseExpression } from 'cron-parser'` throws at runtime** in this ESM-only package,
  and no typecheck catches it. BullMQ's own ESM source uses the named form and gets away with it
  only because Node resolves BullMQ's CJS build.
- **Tick-uniqueness is a driver responsibility, not the supervisor's.** No leader election exists
  because `bullmq` guarantees it in Lua and `memory` is single-process. A future driver with
  neither property double-fires every schedule silently.
- **Lock mode must not release its key on an intermediate failure.** Retries go through
  `moveToDelayed`, not `moveToFinished`. Every other dedup test still passes if this is wrong.
- **`cron.enabled` is deployment-wide, not per-instance.** An instance with it `false` prunes the
  schedules of one with it `true`, so an inconsistent fleet makes schedules flap.

Two known-unresolved items to carry as tracked issues rather than silently:

- Task 6 Step 4 depends on `Queue.getDeduplicationJobId` existing in bullmq 5.63.0. If the grep in
  that step shows it absent, the fallback reads the `de:` key directly, whose layout was read from
  `moveToFinished-14.js` — record which path was taken and why.
- The `memory` driver's debounce `replace` only supersedes a job still in `pending`. A job already
  claimed by the run loop is not replaced, matching BullMQ's own `removeDelayedJob` returning false
  — confirm this against the conformance table and record it either way.
