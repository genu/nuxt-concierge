# Spec 4 — Dashboard and driver introspection: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bullmq-only bull-board wrapper with a dev-only Nuxt DevTools dashboard over
a new driver introspection SPI, so the zero-config path (`memory` driver, no Redis) shows real
queues, workers and failed jobs with decoded payloads.

**Architecture:** A `DriverIntrospection` sub-object is added to `ConciergeDriver` as an optional
property, where presence *is* the capability. `bullmq` implements it fully, `memory` implements it
over a new bounded terminal-history ring buffer, `sync` does not implement it at all. A dev-only
JSON API under `/_concierge/api` reads through the SPI and decodes payload envelopes. A standalone
Vue + `@nuxt/ui` SPA is prebuilt into `dist/client`, served as Nitro public assets, and pointed at
by a Nuxt DevTools iframe tab.

**Tech Stack:** Nuxt 4 module (`@nuxt/kit`), Nitro/h3, BullMQ + ioredis, `devalue`, Vitest,
`@nuxt/devtools-kit`; and for the SPA, Vite + Vue 3 + `@nuxt/ui` v4 + Tailwind v4.

**Spec:** [`specs/2026-08-13-concierge-v2-dashboard-design.md`](../2026-08-13-concierge-v2-dashboard-design.md)

**Prerequisite reading, not optional:**
[phase 1 decisions](../2026-08-13-phase1-decisions.md) and
[spec 3 decisions](../2026-08-13-spec3-decisions.md). The first section of each is build-breaking
or silently behaviour-breaking if violated.

## Global Constraints

- **`attempts` is TOTAL attempts including the first**, matching BullMQ. Never translate between
  "attempts" and "retries" anywhere.
- **Pin every dependency exactly.** No `^` or `~` ranges, in any `package.json` in this repo.
- **Never use `export * from "<path>"` inside a generated `.d.ts`.** Use
  `const x: typeof import("<abs>").x`.
- **Every `#concierge*` alias needs a declaration in BOTH the nitro and app graphs.** This plan
  adds no new aliases; do not remove existing paired declarations.
- **Do not add `defaults:` to `defineNuxtModule`.** `resolveModuleOptions` is the single
  resolution point.
- **Never reintroduce a runtime `process.env.NODE_ENV` read.** `isDev`/`isProduction` come from
  `runtimeConfig.concierge`.
- **Dashboard registration is gated on `nuxt.options.dev` at build time**, never on a runtime
  flag. No env var may re-enable it in production.
- **`decodePayload` error messages must never echo payload content.** They describe shape only.
- **Assertions must be able to fail.** Ask of every one: *would this fail if the behaviour were
  removed?* Bounds must discriminate, not merely pass.
- Node `>=22`, pnpm `10.34.5`, `type: module`, ESM only.

---

## File Structure

**Created:**

| File | Responsibility |
| ---- | -------------- |
| `src/runtime/server/introspect.ts` | Envelope→`PayloadResult` decoding and the API-facing view types shared by every handler |
| `src/runtime/server/routes/api/overview.ts` | `GET /_concierge/api/overview` |
| `src/runtime/server/routes/api/jobs-list.ts` | `GET /_concierge/api/queues/:queue/jobs` |
| `src/runtime/server/routes/api/jobs-detail.ts` | `GET /_concierge/api/queues/:queue/jobs/:id` |
| `src/runtime/server/routes/api/jobs-retry.ts` | `POST /_concierge/api/queues/:queue/jobs/:id/retry` |
| `src/runtime/server/routes/api/registry.ts` | `GET /_concierge/api/registry` |
| `client/` (workspace) | The SPA: Vite + Vue 3 + `@nuxt/ui`, built to `dist/client` |
| `test/unit/introspection-conformance.test.ts` | One shared table over every driver declaring `introspect` |
| `test/unit/introspect.test.ts` | `PayloadResult` discrimination and view mapping |
| `test/unit/api/*.test.ts` | One file per handler, including the five UI states |
| `test/lifecycle/globalSetup.ts` | Builds the playground once for the whole lifecycle project (#21) |
| `test/lifecycle/dashboard.test.ts` | Dev-server end-to-end: fail → observe → retry → observe |

**Modified:**

| File | Change |
| ---- | ------ |
| `src/runtime/server/drivers/types.ts` | `JobState`, `QueueCounts`, `JobSummary`, `JobDetail`, `DriverIntrospection`; `capabilities.history`; `introspect?` |
| `src/runtime/server/drivers/memory.ts` | Terminal-history ring buffer + `introspect` |
| `src/runtime/server/drivers/bullmq.ts` | `introspect` over `getJobCounts`/`getJobs`/`job.retry()` |
| `src/runtime/server/drivers/sync.ts` | `capabilities.history: 'none'`, no `introspect` |
| `src/runtime/server/drivers/index.ts` | `memory` options threaded through `CreateDriverOptions` |
| `src/options.ts` | `MemoryOptions`; delete `managementUI` |
| `src/module.ts` | Delete bull-board wiring; dev-only dashboard registration; `publicAssets`; DevTools tab; banner (#24) |
| `test/unit/module.test.ts` | Dev/prod registration, both halves |
| `test/lifecycle/harness.ts` | `spawnDevApp()` |
| `playground/nuxt.config.ts` | Drop `managementUI` |
| `.github/workflows/ci.yml` | Client build + size budget |
| `package.json`, `pnpm-workspace.yaml` | `client` workspace, scripts, dependency changes |

**Deleted:** `src/runtime/server/routes/ui-handler.ts`.

---

## Task 1: The introspection SPI types, and `sync` declining them

**Files:**
- Modify: `src/runtime/server/drivers/types.ts`
- Modify: `src/runtime/server/drivers/sync.ts:26`
- Modify: `src/runtime/server/drivers/memory.ts:67`
- Modify: `src/runtime/server/drivers/bullmq.ts:121`
- Test: `test/unit/introspection-conformance.test.ts` (created here, grown in Task 5)

**Interfaces:**
- Produces: `JobState`, `QueueCounts`, `JobSummary`, `JobDetail`, `DriverIntrospection`,
  `ConciergeDriver.introspect?`, `DriverCapabilities.history`.
- Consumes: nothing.

This task only adds types and the `history` capability to all three drivers. No driver implements
`introspect` yet — that is Tasks 3 and 4. It ends green because the only behavioural assertion is
that `sync` has no `introspect`, which is true the moment the optional property exists.

- [ ] **Step 1: Write the failing test**

Create `test/unit/introspection-conformance.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createSyncDriver } from '../../src/runtime/server/drivers/sync'

/**
 * The `sync` driver's contract is ABSENCE, which is a stronger and different
 * claim than "calling it fails". A uniform interface returning empty arrays
 * would make "unsupported" indistinguishable from "genuinely empty", and the
 * UI would render a confident empty table that is a lie. This asserts the
 * type-level fact at runtime so a later "helpful" stub implementation breaks
 * this test rather than silently changing what the dashboard shows.
 */
describe('sync driver introspection', () => {
  it('declares no introspection at all', () => {
    const driver = createSyncDriver()
    expect(driver.introspect).toBeUndefined()
  })

  it('reports no history rather than an empty history', () => {
    const driver = createSyncDriver()
    expect(driver.capabilities.history).toBe('none')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run test/unit/introspection-conformance.test.ts`

Expected: FAIL. The first case fails to compile/typecheck under `pnpm typecheck` because
`introspect` does not exist on `ConciergeDriver`; the second fails at runtime with
`expected undefined to be 'none'` because `capabilities.history` does not exist.

- [ ] **Step 3: Add the types**

In `src/runtime/server/drivers/types.ts`, extend `DriverCapabilities` and append the new types:

```ts
export interface DriverCapabilities {
  /** Survives process restart. */
  persistent: boolean
  /** A process that runs no workers can still read this driver's data. */
  crossProcess: boolean
  /**
   * Whether terminal-state results survive, and for how long.
   *
   * The ONLY capability flag this SPI adds, because it is the only question
   * the presence of `introspect` cannot answer. "These results may have been
   * evicted" is information the dashboard must show, and `bounded` is not a
   * degraded `durable` — it changes what the UI is allowed to claim.
   */
  history: 'durable' | 'bounded' | 'none'
}

/**
 * The canonical job states, deliberately five members.
 *
 * BullMQ also has `paused`, `prioritized` and `waiting-children`. Admitting
 * them would make `memory` fabricate three states to satisfy a union shaped by
 * one driver's internals — which is exactly how `depth()` drifted in phase 1
 * before its contract was written down. Driver-specific state belongs in
 * `JobDetail.raw`, which the detail view may display and no code branches on.
 */
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
  /**
   * Attempts already MADE. Never translated to or from "retries" — that
   * conversion is where an off-by-one hides.
   */
  attemptsMade: number
  /** TOTAL attempts including the first, when the driver knows it. */
  attempts?: number
  createdAt: number
  finishedAt?: number
  failedReason?: string
}

export interface JobDetail extends JobSummary {
  /**
   * The RAW stored envelope, never a decoded payload.
   *
   * Decoding belongs to the API layer alone. `decodePayload` owns the
   * `v`-version check AND an error message that deliberately reports `typeof`
   * rather than content, because a payload routinely carries user data and the
   * message reaches both the queue backend and the log stream. Three driver
   * implementations of that path would be three chances to drift, and the
   * drift would be a privacy leak rather than a wrong number.
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

And in `ConciergeDriver`, after `capabilities`:

```ts
  /**
   * Presence IS the capability. A driver either supports introspection or does
   * not, as a type-level fact.
   *
   * The rejected alternative — boolean flags on `capabilities` alongside
   * optional methods — permits a driver declaring support it lacks, or the
   * reverse, and typechecks fine. Same move spec 3 made giving
   * `validateOnEnqueue` a `void` return: make the inconsistent state
   * unrepresentable rather than merely untested.
   */
  readonly introspect?: DriverIntrospection
```

- [ ] **Step 4: Add `history` to all three drivers**

`sync.ts:26` → `capabilities: { persistent: false, crossProcess: false, history: 'none' },`

`memory.ts:67` → `capabilities: { persistent: false, crossProcess: false, history: 'bounded' },`

`bullmq.ts:121` → `capabilities: { persistent: true, crossProcess: true, history: 'durable' },`

`memory` declares `bounded` now, before Task 2 builds the buffer, so the two drivers never
disagree about what the type means mid-plan. Task 2's tests are what make it true.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run test/unit/introspection-conformance.test.ts && pnpm typecheck`

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/server/drivers/types.ts src/runtime/server/drivers/sync.ts \
  src/runtime/server/drivers/memory.ts src/runtime/server/drivers/bullmq.ts \
  test/unit/introspection-conformance.test.ts
git commit -m "feat(drivers): add the introspection SPI types and history capability"
```

---

## Task 2: `memory` driver terminal-state history

**Files:**
- Modify: `src/options.ts`
- Modify: `src/runtime/server/drivers/memory.ts`
- Modify: `src/runtime/server/drivers/index.ts:37-41`
- Test: `test/unit/drivers/memory-history.test.ts`

**Interfaces:**
- Consumes: `JobState` from Task 1.
- Produces: `MemoryOptions { historyLimit: number }`; `createMemoryDriver(opts?: { historyLimit?: number })`;
  an internal `TerminalRecord` retained per queue and read by Task 3.

The memory driver currently retains nothing terminal: `memory.ts:53` holds only `pending`, plus a
per-consume `active` map at line 97, and a failed job is logged at lines 140-153 and dropped.
Without this task, "show me the failed jobs" is empty on exactly the zero-config path this spec
exists to serve.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/drivers/memory-history.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { createMemoryDriver } from '../../../src/runtime/server/drivers/memory'
import type { ConciergeDriver, Consumer } from '../../../src/runtime/server/drivers/types'

const settle = async (predicate: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
}

describe('memory driver terminal history', () => {
  let driver: ConciergeDriver
  let consumer: Consumer | undefined

  afterEach(async () => {
    if (consumer) await consumer.close(true)
    consumer = undefined
    await driver?.close(true)
  })

  it('retains a completed job', async () => {
    driver = createMemoryDriver()
    await driver.init()
    driver.registerHandler('q', 'ok', () => {})
    consumer = driver.consume('q', { concurrency: 1 })

    await driver.enqueue('q', { name: 'ok', payload: { a: 1 } })
    await settle(() => driver.introspect!.counts('q').then(c => c.completed === 1) as never)
    const counts = await driver.introspect!.counts('q')

    expect(counts.completed).toBe(1)
    expect(counts.failed).toBe(0)
  })

  it('retains a permanently failed job with its reason', async () => {
    driver = createMemoryDriver()
    await driver.init()
    driver.registerHandler('q', 'bad', () => { throw new Error('boom') })
    consumer = driver.consume('q', { concurrency: 1 })

    await driver.enqueue('q', { name: 'bad', payload: {}, attempts: 1 })

    let listed: Awaited<ReturnType<NonNullable<ConciergeDriver['introspect']>['list']>> | undefined
    await settle(async () => {
      listed = await driver.introspect!.list('q', 'failed', { offset: 0, limit: 10 })
      return listed.items.length === 1
    } as never)

    expect(listed!.items).toHaveLength(1)
    expect(listed!.items[0]!.state).toBe('failed')
    expect(listed!.items[0]!.failedReason).toContain('boom')
    // Attempts MADE, not a retry count. attempts: 1 means one attempt total.
    expect(listed!.items[0]!.attemptsMade).toBe(1)
  })

  it('evicts oldest-first at the configured limit', async () => {
    driver = createMemoryDriver({ historyLimit: 2 })
    await driver.init()
    driver.registerHandler('q', 'ok', () => {})
    consumer = driver.consume('q', { concurrency: 1 })

    for (const seq of [1, 2, 3]) await driver.enqueue('q', { name: 'ok', payload: { seq } })
    await settle(async () => {
      const c = await driver.introspect!.counts('q')
      return c.completed === 2 && (await driver.introspect!.counts('q')).waiting === 0
    } as never)

    const listed = await driver.introspect!.list('q', 'completed', { offset: 0, limit: 10 })

    // Exactly 2, not ">= 2": a limit that is not enforced would give 3, and a
    // buffer that drops everything would give 0. Both must fail here.
    expect(listed.items).toHaveLength(2)
    expect(listed.total).toBe(2)
    // Oldest-first eviction: mem-1 is gone, mem-2 and mem-3 survive. Asserting
    // only the LENGTH would pass on a buffer that evicts the newest.
    expect(listed.items.map(j => j.id)).not.toContain('mem-1')
    expect(listed.items.map(j => j.id)).toEqual(expect.arrayContaining(['mem-2', 'mem-3']))
  })

  it('still resolves a surviving record by id after others were evicted', async () => {
    driver = createMemoryDriver({ historyLimit: 2 })
    await driver.init()
    driver.registerHandler('q', 'ok', () => {})
    consumer = driver.consume('q', { concurrency: 1 })

    for (const seq of [1, 2, 3]) await driver.enqueue('q', { name: 'ok', payload: { seq } })
    await settle(async () => (await driver.introspect!.counts('q')).completed === 2 as never)

    // The half that catches an eviction which corrupts the index rather than
    // merely dropping a row. A length assertion alone cannot see that.
    const survivor = await driver.introspect!.get('q', 'mem-3')
    expect(survivor).toBeDefined()
    expect(survivor!.id).toBe('mem-3')

    const evicted = await driver.introspect!.get('q', 'mem-1')
    expect(evicted).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run test/unit/drivers/memory-history.test.ts`

Expected: FAIL — `driver.introspect` is `undefined`, so every case throws
`Cannot read properties of undefined (reading 'counts')`.

- [ ] **Step 3: Add `MemoryOptions` to `src/options.ts`**

After `BullmqOptions`:

```ts
export interface MemoryOptions {
  /**
   * Terminal-state records retained per queue, evicted oldest-first.
   *
   * The memory driver is not durable and this is not a durability knob — it
   * exists so the dev dashboard has something to show, since a failed job was
   * previously logged and dropped. `capabilities.history` is `bounded`
   * precisely so the UI can say so rather than implying these results are
   * complete.
   */
  historyLimit: number
}
```

Add `memory?: Partial<MemoryOptions>` to `ModuleOptions` (after `bullmq`), `memory: MemoryOptions`
to `ResolvedConciergeOptions`, and to `moduleDefaults`:

```ts
  memory: {
    historyLimit: 100,
  },
```

Do **not** add a `defaults:` option to `defineNuxtModule` for this, and do not special-case it in
`resolveModuleOptions` — `defu`'s deep merge is correct here, because unlike `worker.queues` this
is a scalar field, not a map whose keys are a declaration.

- [ ] **Step 4: Thread it through `createDriver`**

In `src/runtime/server/drivers/index.ts`, extend `CreateDriverOptions`:

```ts
export interface CreateDriverOptions {
  connection?: { url?: string, host?: string, port?: number, password?: string }
  /** Partial so a caller can override just one field; missing fields fall back to defaults. */
  bullmq?: Partial<BullmqOptions>
  /** Partial for the same reason as `bullmq` above. */
  memory?: Partial<MemoryOptions>
}
```

Import `MemoryOptions` alongside `BullmqOptions`, and pass it in the `memory` branch:

```ts
    case 'memory': {
      const { createMemoryDriver } = await import('./memory')
      return createMemoryDriver(opts.memory)
    }
```

- [ ] **Step 5: Implement the ring buffer in `memory.ts`**

Add above `createMemoryDriver`:

```ts
/** Mirrors moduleDefaults.memory in src/options.ts. */
const MEMORY_DEFAULTS: MemoryOptions = { historyLimit: 100 }

export const resolveMemoryOptions = (opts?: Partial<MemoryOptions>): MemoryOptions => ({
  historyLimit: opts?.historyLimit ?? MEMORY_DEFAULTS.historyLimit,
})

/**
 * A finished job, retained so the dashboard has something to show. Holds the
 * ENVELOPE, not a decoded payload: decoding is the API layer's job (see
 * JobDetail.envelope), and retaining the envelope is also what lets
 * `introspect.retry` re-enqueue the original bytes rather than a re-encoded
 * round trip.
 */
interface TerminalRecord {
  id: string
  name: string
  queue: string
  state: 'completed' | 'failed'
  envelope: { v: number, payload: string }
  attemptsMade: number
  attempts?: number
  backoff?: BackoffOptions
  createdAt: number
  finishedAt: number
  failedReason?: string
  stack?: string
}
```

Change the signature and add the buffer:

```ts
export const createMemoryDriver = (opts?: Partial<MemoryOptions>): ConciergeDriver => {
  const { historyLimit } = resolveMemoryOptions(opts)
  const pending = new Map<string, QueuedJob[]>()
  const handlers = new Map<string, JobHandler>()
  const records = new Map<string, { record: WorkerRecord, expiresAt: number }>()
  const consumers: Consumer[] = []
  /**
   * Terminal records per queue, oldest first. An array rather than a Map
   * because eviction is positional (oldest-first) and the sizes involved are
   * ~100 — a linear scan in `get` is cheaper than maintaining a second index
   * that a `shift()` could desynchronise.
   */
  const history = new Map<string, TerminalRecord[]>()
  /** Live jobs by id, for `counts`/`list`/`get` of non-terminal states. */
  const inFlight = new Map<string, ActiveJob>()
  let counter = 0
```

Add helpers next to `queueOf`:

```ts
  const historyOf = (queue: string) => {
    if (!history.has(queue)) history.set(queue, [])
    return history.get(queue)!
  }

  const remember = (record: TerminalRecord) => {
    const bucket = historyOf(record.queue)
    bucket.push(record)
    // Oldest-first eviction. A `while` rather than a single `shift()` so a
    // lowered historyLimit converges instead of leaking one record per call.
    while (bucket.length > historyLimit) bucket.shift()
  }
```

`QueuedJob` gains `createdAt: number`, set in `enqueue` (`createdAt: Date.now()`) and preserved by
the retry push (it spreads `...job`, so it carries over unchanged — that is intentional: the job's
identity was created once).

In `run`, record both outcomes. In the `try` branch, after `await handler({...})` succeeds:

```ts
          remember({
            id: job.id,
            name: job.name,
            queue,
            state: 'completed',
            envelope: job.envelope,
            attemptsMade: job.attempt,
            attempts: job.attempts,
            backoff: job.backoff,
            createdAt: job.createdAt,
            finishedAt: Date.now(),
          })
```

And in the `else` branch of the `catch` (the terminal-failure branch, after the existing
`logger.error(...)` call):

```ts
          remember({
            id: job.id,
            name: job.name,
            queue,
            state: 'failed',
            envelope: job.envelope,
            attemptsMade: job.attempt,
            attempts: job.attempts,
            backoff: job.backoff,
            createdAt: job.createdAt,
            finishedAt: Date.now(),
            failedReason: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          })
```

Only that `else` branch. Recording in the `willRetry` branch too would put a job in `failed`
history while it is still queued to run again, so the dashboard would show the same job as both
failed and waiting — and the retry button would then enqueue a third copy.

Track in-flight jobs so non-terminal states are listable: in `run`, alongside the existing
`active.set(...)`, add `inFlight.set(job.id, { jobId: job.id, queue, name: job.name, startedAt: Date.now() })`,
and in the `finally`, alongside `active.delete(job.id)`, add `inFlight.delete(job.id)`.

Also clear both new maps in `close`, next to `pending.clear()`:

```ts
      history.clear()
      inFlight.clear()
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/unit/drivers/memory-history.test.ts`

Expected: still FAIL — `introspect` is not implemented until Task 3. This is expected and
correct: this task builds the retention, Task 3 exposes it.

Confirm instead that the retention itself works, with a temporary assertion-free check that the
existing suite has not regressed:

Run: `pnpm vitest run test/unit/drivers/memory.test.ts test/unit/retry-conformance.test.ts && pnpm typecheck`

Expected: PASS. If `retry-conformance` fails, the `remember` call was placed in the `willRetry`
branch rather than the terminal `else`.

- [ ] **Step 7: Commit**

```bash
git add src/options.ts src/runtime/server/drivers/memory.ts \
  src/runtime/server/drivers/index.ts test/unit/drivers/memory-history.test.ts
git commit -m "feat(memory): retain bounded terminal-state history per queue"
```

The new test file is committed still-failing, which is deliberate and is the only place in this
plan where that happens: it is the specification for Task 3, and Task 3's gate is turning it green
without editing it.

---

## Task 3: `memory` driver `introspect`

**Files:**
- Modify: `src/runtime/server/drivers/memory.ts`
- Test: `test/unit/drivers/memory-history.test.ts` (unchanged from Task 2 — do not edit it)

**Interfaces:**
- Consumes: `DriverIntrospection`, `JobState`, `QueueCounts`, `JobSummary`, `JobDetail` (Task 1);
  `TerminalRecord`, `history`, `inFlight`, `pending` (Task 2).
- Produces: `createMemoryDriver().introspect`, fully populated.

- [ ] **Step 1: Confirm the Task 2 tests still fail for the right reason**

Run: `pnpm vitest run test/unit/drivers/memory-history.test.ts`

Expected: FAIL with `Cannot read properties of undefined (reading 'counts')`. If it fails any
other way, fix that before implementing — the test must be failing because `introspect` is absent,
not because of a bug in Task 2's retention.

- [ ] **Step 2: Implement `introspect`**

Add to the returned driver object in `memory.ts`, after `capabilities`:

```ts
    introspect: {
      counts: async (queue) => {
        const now = Date.now()
        const q = queueOf(queue)
        const terminal = historyOf(queue)
        return {
          waiting: q.filter(j => j.runAt <= now).length,
          delayed: q.filter(j => j.runAt > now).length,
          active: [...inFlight.values()].filter(j => j.queue === queue).length,
          completed: terminal.filter(r => r.state === 'completed').length,
          failed: terminal.filter(r => r.state === 'failed').length,
        }
      },

      list: async (queue, state, page) => {
        const all = listByState(queue, state)
        return {
          items: all.slice(page.offset, page.offset + page.limit),
          // `total` is the FULL count, not the page length. The UI's paging
          // control reads it; returning items.length would make every page
          // look like the last one.
          total: all.length,
        }
      },

      get: async (queue, id) => {
        const terminal = historyOf(queue).find(r => r.id === id)
        if (terminal) return toDetail(terminal)

        const queued = queueOf(queue).find(j => j.id === id)
        if (queued) {
          // State computed from runAt, NOT inherited from a shared record
          // shape. An earlier draft of this plan routed a queued job through a
          // `TerminalRecord` whose `state` field defaulted to 'completed',
          // which would have reported every waiting job as completed — a job
          // visible in the waiting list and simultaneously claiming to have
          // finished.
          return {
            id: queued.id,
            name: queued.name,
            queue,
            state: queued.runAt <= Date.now() ? 'waiting' : 'delayed',
            attemptsMade: queued.attempt,
            attempts: queued.attempts,
            createdAt: queued.createdAt,
            envelope: queued.envelope,
          }
        }

        const running = inFlight.get(id)
        if (running && running.queue === queue) {
          const q = queueOf(queue).find(j => j.id === id)
          // An active job is no longer in `pending` (the loop spliced it out),
          // so there is no envelope to show. Reported as `active` with an
          // undefined envelope rather than omitted, so the UI can render "this
          // job is running" instead of "not found".
          return {
            id,
            name: running.name,
            queue,
            state: 'active',
            attemptsMade: q?.attempt ?? 0,
            createdAt: running.startedAt,
            envelope: undefined,
          }
        }

        return undefined
      },

      retry: async (queue, id) => {
        const bucket = historyOf(queue)
        const idx = bucket.findIndex(r => r.id === id && r.state === 'failed')
        if (idx === -1) {
          throw new Error(
            `[nuxt-concierge] no failed job "${id}" on queue "${queue}" to retry. `
            + `The memory driver retains ${historyLimit} terminal records per queue, `
            + `oldest evicted first, so it may already have been dropped.`,
          )
        }

        // Removed from history as it is re-queued: leaving it would show the
        // job as both failed and waiting, and a second click would enqueue a
        // third copy.
        const [record] = bucket.splice(idx, 1)
        queueOf(queue).push({
          id: record!.id,
          name: record!.name,
          queue,
          envelope: record!.envelope,
          // Reset so the retried job gets a full fresh allowance rather than
          // landing immediately back in its exhausted terminal state.
          attempt: 0,
          runAt: Date.now(),
          attempts: record!.attempts,
          backoff: record!.backoff,
          createdAt: record!.createdAt,
        })
      },
    },
```

Add the two helpers above the returned object:

```ts
  const toDetail = (record: TerminalRecord): JobDetail => ({
    id: record.id,
    name: record.name,
    queue: record.queue,
    state: record.state,
    attemptsMade: record.attemptsMade,
    attempts: record.attempts,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt || undefined,
    failedReason: record.failedReason,
    stack: record.stack,
    envelope: record.envelope,
  })

  const listByState = (queue: string, state: JobState): JobSummary[] => {
    const now = Date.now()
    if (state === 'completed' || state === 'failed') {
      return historyOf(queue)
        .filter(r => r.state === state)
        .map(r => toDetail(r))
    }
    if (state === 'active') {
      return [...inFlight.values()]
        .filter(j => j.queue === queue)
        .map(j => ({
          id: j.jobId,
          name: j.name,
          queue,
          state: 'active' as const,
          attemptsMade: 0,
          createdAt: j.startedAt,
        }))
    }
    return queueOf(queue)
      .filter(j => (state === 'waiting' ? j.runAt <= now : j.runAt > now))
      .map(j => ({
        id: j.id,
        name: j.name,
        queue,
        state,
        attemptsMade: j.attempt,
        attempts: j.attempts,
        createdAt: j.createdAt,
      }))
  }
```

Import `JobDetail`, `JobState`, `JobSummary` in the existing type-only import from `./types`.

- [ ] **Step 3: Run the Task 2 tests**

Run: `pnpm vitest run test/unit/drivers/memory-history.test.ts`

Expected: PASS, all four cases, with no edits to the test file.

- [ ] **Step 4: Run the whole unit suite and typecheck**

Run: `pnpm test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/server/drivers/memory.ts
git commit -m "feat(memory): implement the introspection SPI over retained history"
```

---

## Task 4: `bullmq` driver `introspect`

**Files:**
- Modify: `src/runtime/server/drivers/bullmq.ts`
- Test: `test/unit/drivers/bullmq-introspect.test.ts`

**Interfaces:**
- Consumes: `DriverIntrospection` and the view types (Task 1); `queueOf` (existing, `bullmq.ts:112`).
- Produces: `createBullmqDriver().introspect`; exported pure helpers `bullStateToJobState` and
  `jobToSummary` for tests that need no Redis.

- [ ] **Step 1: Write the failing test**

Create `test/unit/drivers/bullmq-introspect.test.ts`. The state mapping and summary projection are
pure, so they are tested without Redis — the round-trip behaviour is covered by Task 5's
conformance table, which does need it.

```ts
import { describe, it, expect } from 'vitest'
import { bullStateToJobState, jobToSummary } from '../../../src/runtime/server/drivers/bullmq'

describe('bullStateToJobState', () => {
  it('maps the five canonical states directly', () => {
    expect(bullStateToJobState('wait')).toBe('waiting')
    expect(bullStateToJobState('active')).toBe('active')
    expect(bullStateToJobState('completed')).toBe('completed')
    expect(bullStateToJobState('failed')).toBe('failed')
    expect(bullStateToJobState('delayed')).toBe('delayed')
  })

  it('folds prioritized into waiting, matching depth()', () => {
    // depth() already counts `prioritized` as due work (bullmq.ts's comment on
    // depth explains why). If this mapping disagreed, a job would be counted
    // by the no-worker guardrail but invisible in the dashboard's waiting list.
    expect(bullStateToJobState('prioritized')).toBe('waiting')
  })

  it('returns undefined for states outside the canonical five', () => {
    // NOT folded into a nearby state: `paused` and `waiting-children` are
    // genuinely not one of the five, and inventing a mapping would make the
    // dashboard claim something false. The caller filters these out.
    expect(bullStateToJobState('paused')).toBeUndefined()
    expect(bullStateToJobState('waiting-children')).toBeUndefined()
    expect(bullStateToJobState('unknown')).toBeUndefined()
  })
})

describe('jobToSummary', () => {
  const job = {
    id: 42,
    name: 'send-email',
    attemptsMade: 2,
    opts: { attempts: 5 },
    timestamp: 1000,
    finishedOn: 5000,
    failedReason: 'smtp down',
  }

  it('stringifies the id, since BullMQ ids are numeric', () => {
    const summary = jobToSummary(job as never, 'mail', 'failed')
    // JobSummary.id is a string across every driver. A numeric id leaking
    // through would make `get(queue, id)` miss on a strict comparison.
    expect(summary.id).toBe('42')
    expect(typeof summary.id).toBe('string')
  })

  it('reports attempts MADE and TOTAL attempts without translating between them', () => {
    const summary = jobToSummary(job as never, 'mail', 'failed')
    expect(summary.attemptsMade).toBe(2)
    expect(summary.attempts).toBe(5)
  })

  it('carries the failure reason and timestamps', () => {
    const summary = jobToSummary(job as never, 'mail', 'failed')
    expect(summary.failedReason).toBe('smtp down')
    expect(summary.createdAt).toBe(1000)
    expect(summary.finishedAt).toBe(5000)
  })

  it('omits finishedAt for a job that has not finished', () => {
    const summary = jobToSummary({ ...job, finishedOn: undefined } as never, 'mail', 'active')
    // Explicitly undefined rather than 0: a 0 would render as the epoch in the
    // UI, which reads as a real timestamp rather than an absent one.
    expect(summary.finishedAt).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run test/unit/drivers/bullmq-introspect.test.ts`

Expected: FAIL with `bullStateToJobState is not a function`.

- [ ] **Step 3: Implement**

Add to `bullmq.ts`, above `createBullmqDriver`:

```ts
/**
 * BullMQ state name -> canonical JobState, or `undefined` for a state outside
 * the canonical five.
 *
 * `prioritized` folds into `waiting` to agree with `depth()`, which already
 * counts it as due work — a disagreement would make a job visible to the
 * no-worker guardrail and invisible in the dashboard. `paused` and
 * `waiting-children` return `undefined` rather than being folded anywhere:
 * inventing a mapping would have the dashboard claim something false, and the
 * caller filters them out.
 */
export const bullStateToJobState = (state: string): JobState | undefined => {
  switch (state) {
    case 'wait':
    case 'waiting':
    case 'prioritized':
      return 'waiting'
    case 'active': return 'active'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'delayed': return 'delayed'
    default: return undefined
  }
}

/** BullMQ's own job states for the canonical five, for `getJobs` queries. */
const BULL_STATES: Record<JobState, JobType[]> = {
  waiting: ['wait', 'prioritized'],
  active: ['active'],
  completed: ['completed'],
  failed: ['failed'],
  delayed: ['delayed'],
}

/**
 * Projects a BullMQ job onto JobSummary. Exported and pure so the mapping is
 * testable without a live Redis — the round trip is covered by the shared
 * conformance table, which does need one.
 */
export const jobToSummary = (job: Job, queue: string, state: JobState): JobSummary => ({
  // String, because BullMQ ids are numeric and JobSummary.id is a string
  // across every driver. A numeric id would make a strict `get` comparison miss.
  id: String(job.id),
  name: job.name,
  queue,
  state,
  attemptsMade: job.attemptsMade,
  attempts: job.opts?.attempts,
  createdAt: job.timestamp,
  // undefined rather than 0: a 0 renders as the epoch, which reads as a real
  // timestamp rather than an absent one.
  finishedAt: job.finishedOn ?? undefined,
  failedReason: job.failedReason ?? undefined,
})
```

Import `Job` and `JobType` as types from `bullmq`, and the view types from `./types`.

Then add to the returned driver object, after `capabilities`:

```ts
    introspect: {
      counts: async (queue) => {
        const c = await queueOf(queue).getJobCounts(
          'wait', 'prioritized', 'active', 'completed', 'failed', 'delayed',
        )
        return {
          // wait + prioritized, matching both depth() and
          // bullStateToJobState. Omitting prioritized would undercount, since
          // BullMQ 5 puts explicitly-prioritised jobs in their own state.
          waiting: (c.wait ?? 0) + (c.prioritized ?? 0),
          active: c.active ?? 0,
          completed: c.completed ?? 0,
          failed: c.failed ?? 0,
          delayed: c.delayed ?? 0,
        }
      },

      list: async (queue, state, page) => {
        const q = queueOf(queue)
        const types = BULL_STATES[state]
        const [jobs, total] = await Promise.all([
          q.getJobs(types, page.offset, page.offset + page.limit - 1),
          q.getJobCountByTypes(...types),
        ])
        return {
          items: jobs.filter(Boolean).map(j => jobToSummary(j, queue, state)),
          total,
        }
      },

      get: async (queue, id) => {
        const job = await queueOf(queue).getJob(id)
        if (!job) return undefined

        const bullState = await job.getState()
        const state = bullStateToJobState(bullState)
        // A job in `paused` or `waiting-children` has no canonical state. It
        // is reported as `waiting` ONLY here, in the detail view, where `raw`
        // carries the true state for display — never in `list`, whose queries
        // are keyed by canonical state.
        return {
          ...jobToSummary(job, queue, state ?? 'waiting'),
          envelope: job.data,
          stack: job.stacktrace?.join('\n') || undefined,
          raw: { bullState, opts: job.opts as Record<string, unknown> },
        }
      },

      retry: async (queue, id) => {
        const job = await queueOf(queue).getJob(id)
        if (!job) throw new Error(`[nuxt-concierge] no job "${id}" on queue "${queue}" to retry.`)
        await job.retry()
      },
    },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/unit/drivers/bullmq-introspect.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/server/drivers/bullmq.ts test/unit/drivers/bullmq-introspect.test.ts
git commit -m "feat(bullmq): implement the introspection SPI"
```

---

## Task 5: The shared introspection conformance table

**Files:**
- Modify: `test/unit/introspection-conformance.test.ts`

**Interfaces:**
- Consumes: `createMemoryDriver` (Task 3), `createBullmqDriver` (Task 4).
- Produces: nothing consumed later.

One table over every driver declaring `introspect`, never per-driver files. Spec 3 established this
convention for the retry contract precisely because two independent files are how `depth()`
drifted; this contract now has three implementations rather than two.

- [ ] **Step 1: Write the table**

Append to `test/unit/introspection-conformance.test.ts`, keeping the two `sync` cases from Task 1:

```ts
import { createMemoryDriver } from '../../src/runtime/server/drivers/memory'
import { createBullmqDriver } from '../../src/runtime/server/drivers/bullmq'
import type { ConciergeDriver, Consumer } from '../../src/runtime/server/drivers/types'

const INTROSPECTING_DRIVERS: Array<[string, () => ConciergeDriver]> = [
  ['memory', () => createMemoryDriver({ historyLimit: 50 })],
  // Only when a real Redis is available, exactly as retry-conformance.test.ts
  // does. Skipping silently is acceptable ONLY because the same table also runs
  // against `memory` unconditionally, so a broken table cannot pass everywhere
  // by being skipped everywhere. CI supplies REDIS_URL.
  ...(process.env.REDIS_URL
    ? [['bullmq', () => createBullmqDriver({
        connection: { url: process.env.REDIS_URL },
        bullmq: { maxStalledCount: 3, stalledInterval: 1000 },
      })] as [string, () => ConciergeDriver]]
    : []),
]

/** Per-process, so an interrupted run's leftovers cannot inflate the next run. */
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

describe.each(INTROSPECTING_DRIVERS)('%s driver introspection contract', (name, make) => {
  let driver: ConciergeDriver
  let consumer: Consumer | undefined
  const queueName = (label: string) => `introspect-${RUN_ID}-${name}-${label}`

  beforeEach(async () => {
    driver = make()
    await driver.init()
    consumer = undefined
  })

  afterEach(async () => {
    if (consumer) await consumer.close(true)
    await driver.close(true)
  })

  const until = async (predicate: () => Promise<boolean>, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise(r => setTimeout(r, 25))
    }
  }

  it('declares introspection and a history capability that is not "none"', () => {
    expect(driver.introspect).toBeDefined()
    // A driver implementing introspection while claiming no history would make
    // the UI hide the very panels this SPI exists to fill.
    expect(driver.capabilities.history).not.toBe('none')
  })

  it('counts a waiting job before any consumer exists', async () => {
    const queue = queueName('waiting')
    await driver.enqueue(queue, { name: 'ok', payload: { a: 1 } })

    const counts = await driver.introspect!.counts(queue)

    // Exactly 1 in waiting AND exactly 0 in active. The second half is what
    // catches a driver that reports every known job in every state.
    expect(counts.waiting).toBe(1)
    expect(counts.active).toBe(0)
    expect(counts.completed).toBe(0)
  })

  it('counts a delayed job as delayed, not as waiting', async () => {
    const queue = queueName('delayed')
    await driver.enqueue(queue, { name: 'ok', payload: {}, delay: 30_000 })

    const counts = await driver.introspect!.counts(queue)

    // Both halves: `delayed` must be 1 and `waiting` must be 0. This is the
    // same distinction depth() encodes, and asserting only `delayed >= 1`
    // would pass on a driver that double-counts into both.
    expect(counts.delayed).toBe(1)
    expect(counts.waiting).toBe(0)
  })

  it('lists a waiting job with its name, queue and state', async () => {
    const queue = queueName('list')
    await driver.enqueue(queue, { name: 'ok', payload: { a: 1 }, attempts: 3 })

    const { items, total } = await driver.introspect!.list(queue, 'waiting', { offset: 0, limit: 10 })

    expect(total).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]!.name).toBe('ok')
    expect(items[0]!.queue).toBe(queue)
    expect(items[0]!.state).toBe('waiting')
    expect(typeof items[0]!.id).toBe('string')
    // TOTAL attempts including the first, passed straight through with no
    // arithmetic anywhere in the chain.
    expect(items[0]!.attempts).toBe(3)
  })

  it('reports total independently of the page size', async () => {
    const queue = queueName('paging')
    for (const seq of [1, 2, 3]) await driver.enqueue(queue, { name: 'ok', payload: { seq } })

    const page = await driver.introspect!.list(queue, 'waiting', { offset: 0, limit: 2 })

    // The discriminating pair: a driver returning items.length as total would
    // give 2 here, and the UI's paging control would think page 1 is the last.
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(3)
  })

  it('returns the raw envelope from get, not a decoded payload', async () => {
    const queue = queueName('envelope')
    const { id } = await driver.enqueue(queue, { name: 'ok', payload: { hello: 'world' } })

    const detail = await driver.introspect!.get(queue, id)

    expect(detail).toBeDefined()
    // The SPI's contract is the raw envelope: `{ v, payload }` with payload a
    // devalue STRING. A driver decoding here would put the decode path — and
    // its deliberately content-free error message — in three places.
    expect(detail!.envelope).toMatchObject({ v: 1 })
    expect(typeof (detail!.envelope as { payload: unknown }).payload).toBe('string')
    // And the decoded form must NOT have leaked through.
    expect(detail!.envelope).not.toMatchObject({ hello: 'world' })
  })

  it('returns undefined from get for an unknown id', async () => {
    const queue = queueName('missing')
    expect(await driver.introspect!.get(queue, 'no-such-job')).toBeUndefined()
  })

  it('moves a permanently failed job into failed, then back to runnable on retry', async () => {
    const queue = queueName('retry')
    let runs = 0
    driver.registerHandler(queue, 'bad', () => { runs++; throw new Error('boom') })
    consumer = driver.consume(queue, { concurrency: 1 })

    const { id } = await driver.enqueue(queue, { name: 'bad', payload: { a: 1 }, attempts: 1 })
    await until(async () => (await driver.introspect!.counts(queue)).failed === 1)

    const failed = await driver.introspect!.list(queue, 'failed', { offset: 0, limit: 10 })
    expect(failed.items).toHaveLength(1)
    expect(failed.items[0]!.failedReason).toContain('boom')
    expect(runs).toBe(1)

    await driver.introspect!.retry(queue, id)
    await until(async () => runs >= 2)

    // Both halves. "It ran again" alone would pass on a retry that enqueues a
    // DUPLICATE while leaving the original in `failed` — so the failed count
    // must have been consumed too, at least transiently. Re-reading after the
    // second failure would be racy, so the assertion is on the run count plus
    // the absence of a second copy.
    expect(runs).toBe(2)
    const afterRetry = await driver.introspect!.list(queue, 'failed', { offset: 0, limit: 10 })
    expect(afterRetry.items.filter(j => j.id === id)).toHaveLength(1)
  })

  it('rejects a retry for a job that does not exist', async () => {
    const queue = queueName('retry-missing')
    // Must throw, not resolve silently: the API layer turns this into a 409 the
    // UI shows. A silent no-op would render as a successful retry that never ran.
    await expect(driver.introspect!.retry(queue, 'no-such-job')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it, memory-only first**

Run: `pnpm vitest run test/unit/introspection-conformance.test.ts`

Expected: PASS for `sync` and `memory`; the `bullmq` block is absent because `REDIS_URL` is unset.

- [ ] **Step 3: Run it against real Redis**

Run: `REDIS_URL=redis://127.0.0.1:6379 pnpm vitest run test/unit/introspection-conformance.test.ts`

Expected: PASS for all three. If Redis is not available locally, note it and rely on CI — but do
not mark this step done without one of the two having run, because the `bullmq` half is the half
with no other coverage.

- [ ] **Step 4: Prove the table can fail**

Temporarily change `memory`'s `counts` to return `delayed: 0` unconditionally. Re-run.

Expected: the delayed case FAILS. Revert the change. This step exists because both prior retros
found assertions that could not fail, twice introduced by fixes for earlier ones — a table that
passes for every driver while asserting nothing is the specific risk here.

- [ ] **Step 5: Commit**

```bash
git add test/unit/introspection-conformance.test.ts
git commit -m "test(drivers): one shared introspection conformance table"
```

---

## Task 6: The `client` workspace and build pipeline

**Files:**
- Create: `client/package.json`, `client/vite.config.ts`, `client/index.html`,
  `client/src/main.ts`, `client/src/App.vue`, `client/src/assets/main.css`, `client/tsconfig.json`
- Modify: `pnpm-workspace.yaml`, `package.json`, `.gitignore`
- Test: `test/unit/client-build.test.ts`

**Interfaces:**
- Produces: `dist/client/index.html` plus hashed assets; root scripts `build:client`, `dev:client`.
- Consumes: nothing.

This task ships a working shell — layout, theme, an API client, and a "connecting" state — but no
panels. Panels are Task 11, after the API they read exists. Ordering matters: Task 7 registers
`dist/client` as public assets, and registering a directory that does not exist yet would make
`pnpm dev` serve a 404 at the tab.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client-build.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import fg from 'fast-glob'

const DIST = resolve(import.meta.dirname, '../../dist/client')

/**
 * Guards the SHIPPED artifact, not the source. `files: ["dist"]` publishes
 * whatever is in dist, and `prepack` is the only thing that builds the client —
 * so a broken client build would otherwise be discovered by a consumer rather
 * than by CI.
 */
describe('the built dashboard client', () => {
  it('emits an index.html', () => {
    expect(existsSync(resolve(DIST, 'index.html'))).toBe(true)
  })

  it('references only relative asset paths', () => {
    const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')
    // Served from /_concierge/ as public assets, so absolute /assets/... paths
    // would resolve against the HOST app's root and 404. This is the failure
    // that presents as a blank panel with no server error.
    expect(html).not.toMatch(/(src|href)="\//)
    expect(html).toMatch(/(src|href)="\.\//)
  })

  it('stays within the bundle size budget', async () => {
    const files = await fg('**/*.{js,css}', { cwd: DIST, absolute: true })
    expect(files.length).toBeGreaterThan(0)
    const total = files.reduce((n, f) => n + statSync(f).size, 0)

    // Ceiling set from the FIRST real measurement in Step 6 below, not
    // invented. Recorded here so a dependency bump that doubles the bundle
    // fails CI rather than arriving silently in a consumer's node_modules.
    expect(total).toBeLessThan(CLIENT_SIZE_BUDGET_BYTES)
  })
})
```

Leave `CLIENT_SIZE_BUDGET_BYTES` undefined for now; Step 6 replaces it with a measured constant.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run test/unit/client-build.test.ts`

Expected: FAIL — `dist/client/index.html` does not exist, and `CLIENT_SIZE_BUDGET_BYTES` is not
defined.

- [ ] **Step 3: Create the workspace**

`pnpm-workspace.yaml`:

```yaml
packages:
  - "docs"
  - "playground"
  - "client"
```

`client/package.json` — every version pinned exactly, per the global constraints:

```json
{
  "name": "@nuxt-concierge/client",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite dev"
  },
  "dependencies": {
    "@nuxt/ui": "4.4.0",
    "tailwindcss": "4.1.18",
    "vue": "3.6.2"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "6.0.1",
    "typescript": "5.9.3",
    "vite": "7.2.4"
  }
}
```

Resolve each pinned version against what `pnpm add` actually installs and update these values to
match; do not leave a version here that was guessed. `private: true` matters — this package is
never published, which is what keeps `@nuxt/ui` and Tailwind out of every consumer's graph.

`client/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'

export default defineConfig({
  plugins: [
    vue(),
    // `router: false` because the SPA has no routes: panels are top-level
    // state, and an iframe has no address bar to deep-link into. This also
    // removes the need for an SPA history fallback on the static route.
    ui({ router: false }),
  ],
  // Relative, NOT '/'. The bundle is served from /_concierge/ as Nitro public
  // assets; absolute asset paths would resolve against the host app's root and
  // 404, which presents as a blank panel with no server-side error.
  base: './',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // So `pnpm dev:client` talks to a running `pnpm dev` playground instead
      // of needing a rebuild per CSS change.
      '/_concierge/api': 'http://localhost:3000',
    },
  },
})
```

`client/src/assets/main.css`:

```css
@import "tailwindcss";
@import "@nuxt/ui";
```

`client/src/main.ts`:

```ts
import { createApp } from 'vue'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import './assets/main.css'

createApp(App).use(ui).mount('#app')
```

`client/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Concierge</title>
  </head>
  <body class="bg-default text-default">
    <div id="app"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
```

`client/src/types.ts` — the response shapes, in their own module rather than exported from
`App.vue`. Task 11 adds an `api.ts` that needs them, and `App.vue` imports `api.ts`, so exporting
them from the component would make those two files import each other.

```ts
/**
 * Mirrors OverviewResponse in src/runtime/server/introspect.ts. Hand-mirrored
 * rather than imported: the SPA is a separate Vite build with no path into the
 * module's source tree, and wiring one up to share four interfaces would couple
 * the client's typecheck to the server's build output.
 */
export interface Overview {
  state: 'starting' | 'running' | 'draining' | 'stopped' | 'absent'
  role: string
  driver: string
  driverHealthy: boolean
  /** Undefined when there is no supervisor, so every read must be optional. */
  capabilities?: { persistent: boolean, crossProcess: boolean, history: 'durable' | 'bounded' | 'none' }
  introspectable: boolean
  version: string
  /** `counts` is absent when the driver has no introspection — not zeroed. */
  queues: Array<{ name: string, concurrency: number, counts?: Record<string, number> }>
  workers: Array<{
    id: string
    pid: number
    role: string
    state: string
    /** Computed server-side. The SPA never derives staleness itself. */
    stale: boolean
    active: unknown[]
  }>
}
```

`client/src/App.vue` — the shell, with the theme rule and a "connecting" state. Interfaces and
imports go in a plain `<script lang="ts">` block, per project convention:

```vue
<script lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { Overview } from './types'
</script>

<script setup lang="ts">
const overview = ref<Overview | undefined>()
const error = ref<string | undefined>()
const paused = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

// prefers-color-scheme plus a manual override, NEVER read off window.parent.
// Sniffing the DevTools frame's theme class would work today (same origin in
// dev) and would couple this panel to someone else's DOM.
const dark = ref(
  localStorage.getItem('concierge-theme')
    ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
)
const applyTheme = () => {
  document.documentElement.classList.toggle('dark', dark.value === 'dark')
  localStorage.setItem('concierge-theme', dark.value)
}
const toggleTheme = () => {
  dark.value = dark.value === 'dark' ? 'light' : 'dark'
  applyTheme()
}

const load = async () => {
  try {
    overview.value = await (await fetch('/_concierge/api/overview')).json()
    error.value = undefined
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(() => {
  applyTheme()
  void load()
  timer = setInterval(() => { if (!paused.value) void load() }, 2000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="p-3 space-y-3">
    <header class="flex items-center justify-between gap-2">
      <h1 class="text-sm font-semibold">Concierge</h1>
      <div class="flex items-center gap-1">
        <UButton
          size="xs"
          variant="ghost"
          :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
          :aria-label="paused ? 'Resume polling' : 'Pause polling'"
          @click="paused = !paused"
        />
        <UButton size="xs" variant="ghost" icon="i-lucide-contrast" aria-label="Toggle theme" @click="toggleTheme" />
      </div>
    </header>

    <UAlert v-if="error" color="error" :title="'Cannot reach the Concierge API'" :description="error" />
    <p v-else-if="!overview" class="text-sm text-muted">Connecting…</p>
    <pre v-else class="text-xs overflow-auto">{{ overview }}</pre>
  </div>
</template>
```

The raw `<pre>` is deliberate and temporary — Task 11 replaces it with the panels. It keeps this
task's deliverable independently verifiable: the shell builds, mounts, themes and polls.

`client/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "vite.config.ts"]
}
```

Add `dist` to `.gitignore` if it is not already ignored.

- [ ] **Step 4: Add the root scripts**

In the root `package.json`:

```json
    "build:client": "pnpm --filter @nuxt-concierge/client build",
    "dev:client": "pnpm --filter @nuxt-concierge/client dev",
    "prepack": "pnpm build:client && nuxt-module-build build",
    "dev:prepare": "pnpm build:client && nuxt-module-build build --stub && nuxt-module-build prepare && nuxi prepare playground",
```

Both changes are load-bearing, not tidiness. Without `build:client` in `dev:prepare`, a fresh
clone's first `pnpm dev` serves a 404 at the DevTools tab, which reads as a broken module rather
than a missing build step. Without it in `prepack`, the published tarball has no dashboard at all.

- [ ] **Step 5: Install and build**

Run: `pnpm install && pnpm build:client`

Expected: `dist/client/index.html` and `dist/client/assets/*` exist.

- [ ] **Step 6: Measure, then set the budget**

Run: `du -sk dist/client && find dist/client -name '*.js' -o -name '*.css' | xargs ls -l`

Take the total `.js` + `.css` byte count, round up to a round number roughly 1.4× above it, and
replace `CLIENT_SIZE_BUDGET_BYTES` in the test with that literal plus a comment recording the
measured value and the date. Then record the same measured number in the spec's "Build and ship
pipeline" section, replacing the sentence that says the ceiling is to be set in the plan.

- [ ] **Step 7: Run the test**

Run: `pnpm vitest run test/unit/client-build.test.ts`

Expected: PASS, all three cases.

- [ ] **Step 8: Verify the dev loop actually works**

Run `pnpm dev` in one shell and `pnpm dev:client` in another. Open the Vite dev server URL.

Expected: the shell renders "Cannot reach the Concierge API" — the API does not exist until Task 8.
That is the correct outcome and confirms the proxy is wired; a *network* error in the browser
console rather than a rendered alert means the proxy target is wrong.

- [ ] **Step 9: Commit**

```bash
git add client pnpm-workspace.yaml package.json pnpm-lock.yaml .gitignore \
  test/unit/client-build.test.ts specs/2026-08-13-concierge-v2-dashboard-design.md
git commit -m "feat(client): scaffold the dashboard SPA and its build pipeline"
```

---

## Task 7: Module rewiring — delete bull-board, gate on dev, register the tab

**Files:**
- Modify: `src/module.ts`
- Modify: `src/options.ts`
- Delete: `src/runtime/server/routes/ui-handler.ts`
- Modify: `playground/nuxt.config.ts:4`
- Modify: `package.json`
- Test: `test/unit/module.test.ts`

**Interfaces:**
- Consumes: `dist/client` from Task 6.
- Produces: `/_concierge/**` static assets and the DevTools tab, both dev-only. Later tasks add
  `addServerHandler` calls for their own API routes.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/module.test.ts`. Both halves are asserted, and the negative half is the one
that matters — a leak into production is the exact failure the registration-time gating exists to
prevent, and it is invisible to every other test in this plan.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A fake Nuxt sufficient for setup() to run: the module's own kit calls are
 * mocked, so this records WHAT the module registers rather than booting Nuxt.
 */
const makeNuxt = (dev: boolean) => ({
  options: {
    dev,
    rootDir: process.cwd(),
    buildDir: `${process.cwd()}/.nuxt`,
    build: { transpile: [] as string[] },
    runtimeConfig: {} as Record<string, unknown>,
    devServer: { url: 'http://localhost:3000' },
    nitro: {},
  },
  hook: vi.fn(),
  hooks: { hook: vi.fn() },
})

const handlers: Array<{ route?: string, middleware?: boolean }> = []
const customTabs: unknown[] = []
const publicAssets: Array<{ baseURL?: string, dir: string }> = []

vi.mock('@nuxt/kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nuxt/kit')>()
  return {
    ...actual,
    addServerHandler: vi.fn((h: { route?: string, middleware?: boolean }) => { handlers.push(h) }),
    addServerPlugin: vi.fn(),
    useLogger: () => ({ success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }
})

vi.mock('@nuxt/devtools-kit', () => ({
  addCustomTab: vi.fn((tab: unknown) => { customTabs.push(tab) }),
}))

describe('dashboard registration is gated on nuxt.options.dev', () => {
  beforeEach(() => {
    handlers.length = 0
    customTabs.length = 0
    publicAssets.length = 0
  })

  it('registers the SPA, the DevTools tab and the API only in dev', async () => {
    const nuxt = makeNuxt(true)
    // @ts-expect-error minimal fake Nuxt, deliberately not the full interface
    await nuxtConciergeModule.setup!({}, nuxt)

    expect(customTabs).toHaveLength(1)
    expect(handlers.some(h => h.route?.startsWith('/_concierge/api'))).toBe(true)
    expect(nuxt.options.runtimeConfig.concierge).toMatchObject({ jobFiles: expect.any(Object) })
  })

  it('registers NONE of it outside dev, while keeping the health route', async () => {
    const nuxt = makeNuxt(false)
    // @ts-expect-error minimal fake Nuxt, deliberately not the full interface
    await nuxtConciergeModule.setup!({}, nuxt)

    // The half that matters. A dashboard reachable in production is what this
    // spec's whole structure exists to prevent, and nothing else here can see it.
    expect(customTabs).toHaveLength(0)
    expect(handlers.some(h => h.route?.startsWith('/_concierge/api'))).toBe(false)
    // Health is NOT part of the dashboard — it is the production readiness
    // probe and must survive.
    expect(handlers.some(h => h.route === '/_concierge/health')).toBe(true)
    // The dev-only registry plumbing must not be baked into a production
    // runtimeConfig, where it would ship absolute build-machine paths.
    expect(nuxt.options.runtimeConfig.concierge).not.toHaveProperty('jobFiles')
  })

  it('no longer registers the bull-board handler or transpiles its packages', async () => {
    const nuxt = makeNuxt(true)
    // @ts-expect-error minimal fake Nuxt, deliberately not the full interface
    await nuxtConciergeModule.setup!({}, nuxt)

    expect(nuxt.options.build.transpile).toEqual([])
    expect(handlers.some(h => h.route === '/_concierge/**')).toBe(false)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run test/unit/module.test.ts`

Expected: FAIL — no DevTools tab is registered, `build.transpile` contains the three bull-board
entries, and `jobFiles` is absent.

- [ ] **Step 3: Delete bull-board**

```bash
git rm src/runtime/server/routes/ui-handler.ts
pnpm remove @bull-board/api @bull-board/h3 @bull-board/ui
pnpm add @nuxt/devtools-kit
```

Pin the `@nuxt/devtools-kit` version exactly in `package.json` after installing.

- [ ] **Step 4: Remove `managementUI`**

Delete the `managementUI?: boolean` member from `ModuleOptions`, the `managementUI?: boolean` from
`ResolvedConciergeOptions`, and the `managementUI: process.env.NODE_ENV === 'development'` line
from `moduleDefaults` in `src/options.ts`. Delete `managementUI: true,` from
`playground/nuxt.config.ts`.

- [ ] **Step 5: Rewire `src/module.ts`**

Replace the three `addServerHandler` calls for `/_concierge` and `/_concierge/**` (lines 49-57)
with nothing — the health handler and the role-gate middleware stay exactly as they are. Delete
the three `nuxt.options.build.transpile.push('@bull-board/*')` lines.

Add near the top of `setup()`, after `const jobs = await scanJobs()`:

```ts
    // Everything below is DEV-ONLY, gated at registration time rather than by a
    // runtime flag. `managementUI` used to make this a config key a user could
    // flip on in production, where /_concierge sat behind nothing but the
    // worker-role gate — a queue dashboard with a retry button and no auth
    // should not be one option away.
    if (nuxt.options.dev) {
      const clientDir = resolve('../dist/client')

      nuxt.hook('nitro:config', (nitroConfig) => {
        nitroConfig.publicAssets ||= []
        nitroConfig.publicAssets.push({ dir: clientDir, baseURL: '/_concierge', maxAge: 0 })
      })

      for (const route of [
        '/_concierge/api/overview',
        '/_concierge/api/registry',
        '/_concierge/api/queues/:queue/jobs',
        '/_concierge/api/queues/:queue/jobs/:id',
        '/_concierge/api/queues/:queue/jobs/:id/retry',
      ]) {
        // Each API task below adds its own handler file; the routes are
        // declared together here so the dev/prod gate has one home.
        addServerHandler({ route, handler: resolve(API_HANDLERS[route]) })
      }

      addCustomTab({
        name: 'concierge',
        title: 'Concierge',
        icon: 'carbon:queued',
        view: { type: 'iframe', src: '/_concierge/' },
      })
    }
```

For this task, `API_HANDLERS` maps only routes whose handler files exist. Since none exist yet,
start with an empty registration loop and a `// Tasks 8-10 populate this` comment, then add each
entry in the task that creates its handler. The module test's `handlers.some(h =>
h.route?.startsWith('/_concierge/api'))` assertion therefore cannot pass until Task 8 — so for
*this* task, change that one assertion to check the DevTools tab and `publicAssets` only, and
Task 8 restores it. Note the change in the commit message so it is not mistaken for a weakened
test.

Replace the dev banner (lines 154-160) with:

```ts
    if (nuxt.options.dev) {
      // No URL, which is how #24 is fixed: setup() runs BEFORE the server
      // listens, so nuxt.options.devServer.url is not yet correct here — it
      // logged port 3000 whenever 3000 was taken. Pointing at the DevTools tab
      // leaves no port to get wrong.
      logger.info('Concierge dashboard: open the Concierge tab in Nuxt DevTools')
    }
```

Import `addCustomTab` from `@nuxt/devtools-kit`.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/unit/module.test.ts && pnpm typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 7: Verify by hand that the SPA is actually served**

Run `pnpm dev:prepare && pnpm dev`, then open Nuxt DevTools and the Concierge tab.

Expected: the Task 6 shell renders inside the tab. **This is the experiment the spec requires**
for the `publicAssets` fallthrough assumption. Record the outcome in the spec: either that
`publicAssets` resolves `index.html` for a bare `/_concierge/` and falls through to the API
handlers, or that the fallback (an explicit dev-only `index.html` handler with assets under
`/_concierge/ui/`) was needed. Do not skip this step — a silent mis-resolution here presents as an
empty panel rather than an error.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat!: replace bull-board with a dev-only DevTools dashboard shell

Deletes ui-handler.ts, the three @bull-board dependencies, their
build.transpile entries and the managementUI option. Registration is
gated on nuxt.options.dev at build time, so nothing dashboard-related
exists in a production bundle.

Fixes #24 by deletion: setup() runs before the server listens, so the
banner's devServer.url was wrong whenever port 3000 was taken. Pointing
at the DevTools tab leaves no port to get wrong.

The module test's API-route assertion is narrowed to the tab and public
assets in this commit, and restored once the first handler lands."
```

---

## Task 8: `GET /_concierge/api/overview`

**Files:**
- Create: `src/runtime/server/introspect.ts`
- Create: `src/runtime/server/routes/api/overview.ts`
- Modify: `src/module.ts` (add the route to `API_HANDLERS`)
- Modify: `test/unit/module.test.ts` (restore the narrowed assertion)
- Test: `test/unit/api/overview.test.ts`

**Interfaces:**
- Consumes: `getSupervisor` (`supervisor.ts:86`), driver `capabilities`/`introspect`.
- Produces: `buildOverview(supervisor: Supervisor | undefined): Promise<OverviewResponse>` from
  `introspect.ts`. `heartbeatTtl` is read off `supervisor.config.worker`, not passed in — one
  parameter, so a caller cannot supply a TTL that disagrees with the supervisor's own.

- [ ] **Step 1: Write the failing test**

Create `test/unit/api/overview.test.ts`. Every one of the five UI states from the spec is a case
here, because "empty table" is a lie in four of them.

```ts
import { describe, it, expect } from 'vitest'
import { buildOverview } from '../../../src/runtime/server/introspect'
import type { Supervisor } from '../../../src/runtime/server/supervisor'

const fakeSupervisor = (over: Partial<{
  state: string
  driverName: string
  healthy: boolean
  history: 'durable' | 'bounded' | 'none'
  introspectable: boolean
  workers: Array<{ id: string, lastHeartbeat: number }>
}> = {}) => ({
  getState: () => over.state ?? 'running',
  config: {
    role: 'both',
    version: '1.2.3',
    worker: { queues: { default: 5 }, heartbeatTtl: 15_000 },
  },
  consumers: new Map(),
  driver: {
    name: over.driverName ?? 'memory',
    isHealthy: () => over.healthy ?? true,
    capabilities: {
      persistent: false,
      crossProcess: false,
      history: over.history ?? 'bounded',
    },
    introspect: (over.introspectable ?? true)
      ? {
          counts: async () => ({ waiting: 1, active: 0, completed: 2, failed: 3, delayed: 0 }),
          list: async () => ({ items: [], total: 0 }),
          get: async () => undefined,
          retry: async () => {},
        }
      : undefined,
    workers: async () => over.workers ?? [],
  },
} as unknown as Supervisor)

describe('buildOverview', () => {
  it('reports "absent" rather than a supervisor state when there is no supervisor', async () => {
    const result = await buildOverview(undefined)

    // NOT 'stopped': the supervisor may never have existed at all (mid-boot),
    // and SupervisorState gets no new member for a case that only exists when
    // there IS no supervisor. Same reasoning as health.ts's `ready: false`.
    expect(result.state).toBe('absent')
    expect(result.queues).toEqual([])
    expect(result.introspectable).toBe(false)
  })

  it('flags a driver with no introspection instead of returning empty counts', async () => {
    const result = await buildOverview(fakeSupervisor({ introspectable: false, history: 'none' }))

    // Both halves. `introspectable: false` is what lets the UI say "this driver
    // cannot do this" rather than rendering a confident empty table; and the
    // queue must still be LISTED, so the UI can name it.
    expect(result.introspectable).toBe(false)
    expect(result.queues.map(q => q.name)).toEqual(['default'])
    expect(result.queues[0]!.counts).toBeUndefined()
  })

  it('carries the history capability through so the UI can label evictions', async () => {
    const result = await buildOverview(fakeSupervisor({ history: 'bounded' }))
    expect(result.capabilities.history).toBe('bounded')
  })

  it('reports an unhealthy driver without omitting the counts it last read', async () => {
    const result = await buildOverview(fakeSupervisor({ healthy: false }))

    // Both halves: the flag must be false AND the counts must still be present,
    // so the UI can show a banner over stale data rather than a blank panel.
    expect(result.driverHealthy).toBe(false)
    expect(result.queues[0]!.counts).toMatchObject({ failed: 3 })
  })

  it('marks a worker whose heartbeat is older than heartbeatTtl as stale', async () => {
    const fresh = { id: 'a', lastHeartbeat: Date.now(), active: [] }
    const old = { id: 'b', lastHeartbeat: Date.now() - 60_000, active: [] }
    const result = await buildOverview(fakeSupervisor({ workers: [fresh, old] as never }))

    // Computed server-side, per the "SPA holds no business logic" rule. Both
    // halves asserted: a rule marking EVERYTHING stale would pass on the
    // second assertion alone.
    expect(result.workers.find(w => w.id === 'a')!.stale).toBe(false)
    expect(result.workers.find(w => w.id === 'b')!.stale).toBe(true)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run test/unit/api/overview.test.ts`

Expected: FAIL — `buildOverview` does not exist.

- [ ] **Step 3: Create `src/runtime/server/introspect.ts`**

```ts
import { decodePayload } from './envelope'
import type { Supervisor } from './supervisor'
import type { DriverCapabilities, JobDetail, QueueCounts } from './drivers/types'

/**
 * A decoded payload, or the reason it could not be decoded.
 *
 * Discriminated rather than a bare value so a decode failure renders as a
 * visible error. It must not render blank, and it must not fall back to showing
 * the raw envelope string — that would reintroduce exactly the payload-content
 * leak `decodePayload`'s shape-only error message exists to avoid.
 */
export type PayloadResult
  = { ok: true, value: unknown }
  | { ok: false, error: string }

export const decodeForDisplay = (envelope: unknown): PayloadResult => {
  try {
    return { ok: true, value: decodePayload(envelope) }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface WorkerView {
  id: string
  hostname: string
  pid: number
  role: string
  queues: string[]
  version: string
  startedAt: number
  lastHeartbeat: number
  state: string
  active: unknown[]
  /**
   * Computed HERE, not in the client. The SPA renders flags; every derived
   * state lives server-side, which is the sole reason this spec ships no
   * client-side tests.
   */
  stale: boolean
}

export interface OverviewResponse {
  /** `absent` when there is no supervisor at all — never a SupervisorState. */
  state: 'starting' | 'running' | 'draining' | 'stopped' | 'absent'
  role: string
  driver: string
  driverHealthy: boolean
  capabilities: DriverCapabilities | undefined
  /** Whether the driver implements introspection at all. Presence is the capability. */
  introspectable: boolean
  version: string
  queues: Array<{ name: string, concurrency: number, counts?: QueueCounts }>
  workers: WorkerView[]
}

export const buildOverview = async (supervisor: Supervisor | undefined): Promise<OverviewResponse> => {
  if (!supervisor) {
    return {
      state: 'absent',
      role: 'unknown',
      driver: 'none',
      driverHealthy: false,
      capabilities: undefined,
      introspectable: false,
      version: 'unknown',
      queues: [],
      workers: [],
    }
  }

  const { driver, config } = supervisor
  const introspect = driver.introspect
  const names = Object.keys(config.worker.queues)

  const queues = await Promise.all(names.map(async name => ({
    name,
    concurrency: config.worker.queues[name]!,
    // Undefined, not zeroes: a driver with no introspection has UNKNOWN counts,
    // and zeroes would have the UI render a confident empty table.
    counts: introspect ? await introspect.counts(name) : undefined,
  })))

  const now = Date.now()
  const records = await driver.workers()

  return {
    state: supervisor.getState(),
    role: config.role,
    driver: driver.name,
    driverHealthy: driver.isHealthy(),
    capabilities: driver.capabilities,
    introspectable: Boolean(introspect),
    version: config.version,
    queues,
    workers: records.map(r => ({
      ...r,
      stale: now - r.lastHeartbeat > config.worker.heartbeatTtl,
    })),
  }
}

export type { JobDetail }
```

- [ ] **Step 4: Create the handler**

`src/runtime/server/routes/api/overview.ts`:

```ts
import { defineEventHandler } from 'h3'
import { getSupervisor } from '../../supervisor'
import { buildOverview } from '../../introspect'

/**
 * Registered only under nuxt.options.dev (see src/module.ts), so this file is
 * never part of a production bundle. It therefore needs no auth check — there
 * is deliberately no configuration that makes it reachable in production.
 */
export default defineEventHandler(async () => buildOverview(getSupervisor()))
```

- [ ] **Step 5: Register it**

In `src/module.ts`, populate the API route map with this one entry:

```ts
      const API_HANDLERS: Record<string, string> = {
        '/_concierge/api/overview': './runtime/server/routes/api/overview',
      }
```

Restore the narrowed assertion in `test/unit/module.test.ts` from Task 7 Step 5 back to
`expect(handlers.some(h => h.route?.startsWith('/_concierge/api'))).toBe(true)`.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/unit/api test/unit/module.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Verify against the running dev server**

With `pnpm dev` running: `curl -s localhost:3000/_concierge/api/overview | head -40`

Expected: JSON with `state: "running"`, `driver: "memory"`, `introspectable: true`, one queue
`default`, and at least one worker.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/server/introspect.ts src/runtime/server/routes/api/overview.ts \
  src/module.ts test/unit/api/overview.test.ts test/unit/module.test.ts
git commit -m "feat(api): add the dev-only overview endpoint"
```

---

## Task 9: Job list, detail and retry endpoints

**Files:**
- Create: `src/runtime/server/routes/api/jobs-list.ts`, `jobs-detail.ts`, `jobs-retry.ts`
- Modify: `src/module.ts` (three `API_HANDLERS` entries)
- Modify: `src/runtime/server/introspect.ts` (add `toDetailResponse`)
- Test: `test/unit/api/jobs.test.ts`

**Interfaces:**
- Consumes: `decodeForDisplay`, `PayloadResult` (Task 8); `DriverIntrospection` (Task 1).
- Produces: `toDetailResponse(detail): JobDetailResponse` where `envelope` is replaced by
  `payload: PayloadResult`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/api/jobs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toDetailResponse, decodeForDisplay } from '../../../src/runtime/server/introspect'
import { encodePayload } from '../../../src/runtime/server/envelope'

describe('decodeForDisplay', () => {
  it('decodes a valid envelope', () => {
    const result = decodeForDisplay(encodePayload({ hello: 'world' }))
    expect(result).toEqual({ ok: true, value: { hello: 'world' } })
  })

  it('reports a failure for an unrecognised envelope version', () => {
    const result = decodeForDisplay({ v: 99, payload: '[]' })

    // BOTH branches are asserted across these two cases. A failure-only test
    // passes against an implementation that never succeeds, and a success-only
    // test passes against one that never catches.
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('version 99')
  })

  it('does not echo payload content in the failure message', () => {
    const result = decodeForDisplay({ v: 1, payload: 'not-devalue-at-all' })

    expect(result.ok).toBe(false)
    // The message describes SHAPE only. A payload routinely carries user data,
    // and this string reaches the UI, the log stream and (via the driver's
    // UnrecoverableError) the queue backend.
    expect(result.ok === false && result.error).not.toContain('not-devalue-at-all')
  })
})

describe('toDetailResponse', () => {
  const detail = {
    id: '1',
    name: 'send-email',
    queue: 'mail',
    state: 'failed' as const,
    attemptsMade: 1,
    createdAt: 1000,
    envelope: encodePayload({ to: 'a@b.c' }),
    failedReason: 'smtp down',
  }

  it('replaces the envelope with a decoded payload result', () => {
    const response = toDetailResponse(detail)

    expect(response.payload).toEqual({ ok: true, value: { to: 'a@b.c' } })
    // The raw envelope must NOT survive into the response: it would put the
    // devalue string in front of the user and give the client a second,
    // undecoded copy of the payload to be tempted into parsing itself.
    expect(response).not.toHaveProperty('envelope')
  })

  it('preserves the summary fields alongside the decoded payload', () => {
    const response = toDetailResponse(detail)
    expect(response.id).toBe('1')
    expect(response.failedReason).toBe('smtp down')
    expect(response.attemptsMade).toBe(1)
  })

  it('surfaces a decode failure rather than dropping the job', () => {
    const response = toDetailResponse({ ...detail, envelope: { v: 42, payload: '[]' } })

    // The job is still returned — its id, state and failure reason are exactly
    // what you need when the payload is the thing that is broken.
    expect(response.id).toBe('1')
    expect(response.payload.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run test/unit/api/jobs.test.ts`

Expected: FAIL — `toDetailResponse` does not exist.

- [ ] **Step 3: Add `toDetailResponse`**

In `src/runtime/server/introspect.ts`:

```ts
export interface JobDetailResponse extends Omit<JobDetail, 'envelope'> {
  payload: PayloadResult
}

/**
 * Replaces the raw envelope with a decoded result. The envelope is DROPPED, not
 * carried alongside: keeping it would put a devalue string in front of the user
 * and hand the client a second, undecoded copy it could be tempted to parse —
 * which is how the decode path would end up duplicated in the SPA.
 */
export const toDetailResponse = (detail: JobDetail): JobDetailResponse => {
  const { envelope, ...rest } = detail
  return { ...rest, payload: decodeForDisplay(envelope) }
}
```

- [ ] **Step 4: Create the three handlers**

`src/runtime/server/routes/api/jobs-list.ts`:

```ts
import { defineEventHandler, getRouterParam, getQuery, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import type { JobState } from '../../drivers/types'

const STATES: JobState[] = ['waiting', 'active', 'completed', 'failed', 'delayed']

/** Bounded so a hand-crafted `limit=1000000` cannot make the dev server hang. */
const MAX_LIMIT = 100

export default defineEventHandler(async (event) => {
  const supervisor = getSupervisor()
  // `supervisor` is checked on its own rather than via `supervisor?.driver`,
  // because narrowing `introspect` does not narrow `supervisor` — and the queue
  // validation below reads `supervisor.config`.
  if (!supervisor?.driver.introspect) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support introspection' }
  }
  const introspect = supervisor.driver.introspect

  const queue = getRouterParam(event, 'queue')
  if (!queue || !(queue in supervisor.config.worker.queues)) {
    setResponseStatus(event, 404)
    return { error: `unknown queue "${queue}"` }
  }

  const query = getQuery(event)
  const state = String(query.state ?? 'failed') as JobState
  if (!STATES.includes(state)) {
    setResponseStatus(event, 400)
    return { error: `unknown state "${state}"; expected one of: ${STATES.join(' | ')}` }
  }

  const offset = Math.max(0, Number(query.offset ?? 0) || 0)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit ?? 25) || 25))

  return introspect.list(queue, state, { offset, limit })
})
```

`src/runtime/server/routes/api/jobs-detail.ts`:

```ts
import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'
import { toDetailResponse } from '../../introspect'

export default defineEventHandler(async (event) => {
  const introspect = getSupervisor()?.driver.introspect
  if (!introspect) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support introspection' }
  }

  const queue = getRouterParam(event, 'queue')!
  const id = getRouterParam(event, 'id')!
  const detail = await introspect.get(queue, id)

  if (!detail) {
    setResponseStatus(event, 404)
    return { error: `no job "${id}" on queue "${queue}"` }
  }

  return toDetailResponse(detail)
})
```

`src/runtime/server/routes/api/jobs-retry.ts`:

```ts
import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSupervisor } from '../../supervisor'

export default defineEventHandler(async (event) => {
  const introspect = getSupervisor()?.driver.introspect
  if (!introspect) {
    setResponseStatus(event, 503)
    return { error: 'this driver does not support introspection' }
  }

  const queue = getRouterParam(event, 'queue')!
  const id = getRouterParam(event, 'id')!

  try {
    await introspect.retry(queue, id)
    setResponseStatus(event, 204)
    return null
  }
  catch (error) {
    // 409, with the driver's own message. The memory driver's message names
    // eviction as a likely cause, which is exactly what a developer needs to
    // read; swallowing it into a generic 500 would render as "retry failed"
    // with no reason.
    setResponseStatus(event, 409)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
```

- [ ] **Step 5: Register all three**

Add to `API_HANDLERS` in `src/module.ts`:

```ts
        '/_concierge/api/queues/:queue/jobs': './runtime/server/routes/api/jobs-list',
        '/_concierge/api/queues/:queue/jobs/:id': './runtime/server/routes/api/jobs-detail',
        '/_concierge/api/queues/:queue/jobs/:id/retry': './runtime/server/routes/api/jobs-retry',
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/unit/api && pnpm typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 7: Verify end to end by hand**

With `pnpm dev` running, enqueue a failing job via the playground, then:

```bash
curl -s 'localhost:3000/_concierge/api/queues/default/jobs?state=failed' | head -20
curl -s -X POST localhost:3000/_concierge/api/queues/default/jobs/mem-1/retry -i | head -5
curl -s -X POST localhost:3000/_concierge/api/queues/default/jobs/nope/retry | head -5
```

Expected: a populated list; `204` for the real id; `409` with a readable message for `nope`.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/server/introspect.ts src/runtime/server/routes/api src/module.ts \
  test/unit/api/jobs.test.ts
git commit -m "feat(api): add job list, detail and retry endpoints"
```

---

## Task 10: The registry endpoint and its dev-only plumbing

**Files:**
- Create: `src/runtime/server/routes/api/registry.ts`
- Modify: `src/module.ts` (write `jobFiles` and `generatedTypesPath` into dev runtimeConfig)
- Modify: `src/options.ts` (dev-only resolved fields)
- Test: `test/unit/api/registry.test.ts`

**Interfaces:**
- Consumes: `scanJobs()` output (`scan.ts:7-10`), `supervisor.registry` (`supervisor.ts:57`),
  `runtimeConfig.concierge.jobFiles`.
- Produces: `buildRegistry(supervisor, jobFiles, typesPath)`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/api/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildRegistry } from '../../../src/runtime/server/routes/api/registry'
import type { Supervisor } from '../../../src/runtime/server/supervisor'

const fakeSupervisor = () => ({
  registry: new Map([
    ['send-email', { queue: 'mail', input: z.object({ to: z.string() }), attempts: 5 }],
    ['sweep', { queue: 'default' }],
  ]),
  config: {
    worker: { queues: { mail: 2, default: 5 } },
    defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
  },
} as unknown as Supervisor)

describe('buildRegistry', () => {
  it('reports the schema vendor for a job that declares one', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), {}, undefined)
    const job = jobs.find(j => j.name === 'send-email')!

    // The PAYLOAD TYPE is erased at build and cannot be recovered at runtime.
    // Vendor and presence are what actually exist, and saying so is better than
    // a panel implying it computed a type.
    expect(job.hasSchema).toBe(true)
    expect(job.schemaVendor).toBe('zod')
  })

  it('reports no schema for a job that declares none, without inventing a vendor', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), {}, undefined)
    const job = jobs.find(j => j.name === 'sweep')!

    expect(job.hasSchema).toBe(false)
    expect(job.schemaVendor).toBeUndefined()
  })

  it('distinguishes a job-declared retry policy from an inherited default', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), {}, undefined)

    // Both halves. "attempts: 5" alone does not tell a developer whether the
    // job set it or inherited it — which is the whole question you open this
    // panel to answer.
    expect(jobs.find(j => j.name === 'send-email')!.attempts).toEqual({ value: 5, from: 'job' })
    expect(jobs.find(j => j.name === 'sweep')!.attempts).toEqual({ value: 3, from: 'defaults' })
  })

  it('includes the source file when the module supplied one', () => {
    const { jobs } = buildRegistry(fakeSupervisor(), { 'send-email': '/app/server/jobs/send-email.ts' }, undefined)
    expect(jobs.find(j => j.name === 'send-email')!.file).toBe('/app/server/jobs/send-email.ts')
  })

  it('omits generated types rather than failing when the path is absent', () => {
    const result = buildRegistry(fakeSupervisor(), {}, undefined)
    // The panel must still render its job table. A missing .d.ts is a dev-setup
    // detail, not a reason to 500 the whole endpoint.
    expect(result.generatedTypes).toBeUndefined()
    expect(result.jobs).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run test/unit/api/registry.test.ts`

Expected: FAIL — `buildRegistry` does not exist.

- [ ] **Step 3: Implement**

`src/runtime/server/routes/api/registry.ts`:

```ts
import { readFileSync } from 'node:fs'
import { defineEventHandler } from 'h3'
import { useRuntimeConfig } from '#imports'
import { getSupervisor } from '../../supervisor'
import type { Supervisor } from '../../supervisor'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export interface RegistryJobView {
  name: string
  queue: string
  file?: string
  hasSchema: boolean
  /** e.g. "zod", "valibot", "arktype". Never a payload TYPE — that is erased at build. */
  schemaVendor?: string
  attempts: { value: number, from: 'job' | 'defaults' }
  backoff: { value: { type: string, delay: number }, from: 'job' | 'defaults' }
}

export interface RegistryResponse {
  jobs: RegistryJobView[]
  /** The generated job map .d.ts, verbatim. Undefined when unavailable. */
  generatedTypes?: string
}

export const buildRegistry = (
  supervisor: Supervisor | undefined,
  jobFiles: Record<string, string>,
  typesPath: string | undefined,
): RegistryResponse => {
  if (!supervisor) return { jobs: [] }

  const { defaults } = supervisor.config
  const jobs: RegistryJobView[] = [...supervisor.registry.entries()].map(([name, entry]) => {
    const schema = entry.input as StandardSchemaV1 | undefined
    return {
      name,
      queue: entry.queue,
      file: jobFiles[name],
      hasSchema: Boolean(schema),
      // Read off the Standard Schema spec's own metadata. This is the most the
      // runtime knows about a schema — the payload type is compile-time only.
      schemaVendor: schema?.['~standard']?.vendor,
      attempts: entry.attempts !== undefined
        ? { value: entry.attempts, from: 'job' }
        : { value: defaults.attempts, from: 'defaults' },
      backoff: entry.backoff !== undefined
        ? { value: entry.backoff, from: 'job' }
        : { value: defaults.backoff, from: 'defaults' },
    }
  })

  let generatedTypes: string | undefined
  if (typesPath) {
    try {
      generatedTypes = readFileSync(typesPath, 'utf8')
    }
    catch {
      // A missing .d.ts is a dev-setup detail, not a reason to fail the whole
      // endpoint and take the job table down with it.
      generatedTypes = undefined
    }
  }

  return { jobs, generatedTypes }
}

export default defineEventHandler(() => {
  const config = useRuntimeConfig().concierge as {
    jobFiles?: Record<string, string>
    generatedTypesPath?: string
  }
  return buildRegistry(getSupervisor(), config.jobFiles ?? {}, config.generatedTypesPath)
})
```

- [ ] **Step 4: Plumb the dev-only config**

In `src/module.ts`, inside the existing `if (nuxt.options.dev)` block, before `addCustomTab`:

```ts
      // Dev-only, and it must STAY dev-only: these are absolute build-machine
      // paths, and baking them into a production runtimeConfig would ship one
      // developer's directory layout to every deployment.
      nuxt.options.runtimeConfig.concierge = defu(
        {
          jobFiles: Object.fromEntries(jobs.map(job => [job.name, job.file])),
          generatedTypesPath: `${nuxt.options.buildDir}/types/concierge-jobs.d.ts`,
        },
        nuxt.options.runtimeConfig.concierge,
      )
```

Add the route to `API_HANDLERS`:

```ts
        '/_concierge/api/registry': './runtime/server/routes/api/registry',
```

Add the two fields to `ResolvedConciergeOptions` in `src/options.ts` as optional, with a comment
that they are populated only in dev:

```ts
  /** Dev-only, written by the module. Absolute paths; never present in production. */
  jobFiles?: Record<string, string>
  /** Dev-only, written by the module. Absolute path; never present in production. */
  generatedTypesPath?: string
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/unit/api test/unit/module.test.ts && pnpm typecheck`

Expected: PASS, including the Task 7 case asserting `jobFiles` is absent when `dev: false`.

- [ ] **Step 6: Verify by hand**

With `pnpm dev` running: `curl -s localhost:3000/_concierge/api/registry | head -40`

Expected: the three playground jobs (`failing`, `slow`, `typed`) with real absolute file paths,
`typed` showing `hasSchema: true` and a vendor, and `generatedTypes` containing the generated
`ConciergeJobMap`.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/routes/api/registry.ts src/module.ts src/options.ts \
  test/unit/api/registry.test.ts
git commit -m "feat(api): add the registry endpoint with dev-only job-file plumbing"
```

---

## Task 11: The SPA panels

**Files:**
- Create: `client/src/panels/OverviewPanel.vue`, `JobsPanel.vue`, `RegistryPanel.vue`
- Create: `client/src/api.ts`
- Modify: `client/src/App.vue`
- Test: `test/unit/client-build.test.ts` (size budget re-measured)

**Interfaces:**
- Consumes: the four API endpoints from Tasks 8-10.
- Produces: nothing consumed later.

No component tests, deliberately, and that is only defensible because of the "SPA holds no business
logic" rule: every derived state — `stale`, `introspectable`, `history: 'bounded'`, `from: 'job'` —
arrives as a server-computed flag. **If you find yourself computing a derived state in this task,
that logic belongs in `introspect.ts` with a unit test.** Treat it as a design violation, not as
untested code.

- [ ] **Step 1: Extract the API client**

`client/src/api.ts`:

```ts
import type { Overview } from './types'

const json = async <T>(url: string): Promise<T> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const api = {
  overview: () => json<Overview>('/_concierge/api/overview'),
  jobs: (queue: string, state: string, offset = 0, limit = 25) =>
    json<{ items: JobSummaryView[], total: number }>(
      `/_concierge/api/queues/${encodeURIComponent(queue)}/jobs?state=${state}&offset=${offset}&limit=${limit}`,
    ),
  job: (queue: string, id: string) =>
    json<JobDetailView>(
      `/_concierge/api/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}`,
    ),
  retry: async (queue: string, id: string) => {
    const res = await fetch(
      `/_concierge/api/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}/retry`,
      { method: 'POST' },
    )
    if (res.status === 204) return
    // The server's 409 message names the actual cause (e.g. eviction from the
    // memory driver's bounded history). Surfacing it beats a generic failure.
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `retry failed with ${res.status}`)
  },
  registry: () => json<RegistryView>('/_concierge/api/registry'),
}

export interface JobSummaryView {
  id: string
  name: string
  queue: string
  state: string
  attemptsMade: number
  attempts?: number
  createdAt: number
  finishedAt?: number
  failedReason?: string
}

export interface JobDetailView extends JobSummaryView {
  payload: { ok: true, value: unknown } | { ok: false, error: string }
  stack?: string
  raw?: Record<string, unknown>
}

export interface RegistryView {
  jobs: Array<{
    name: string
    queue: string
    file?: string
    hasSchema: boolean
    schemaVendor?: string
    attempts: { value: number, from: 'job' | 'defaults' }
    backoff: { value: { type: string, delay: number }, from: 'job' | 'defaults' }
  }>
  generatedTypes?: string
}
```

- [ ] **Step 2: Build `OverviewPanel.vue`**

Props interface first, per project convention. It renders queues and workers, and handles three of
the five defined states.

```vue
<script lang="ts">
import type { Overview } from '../types'

export interface Props {
  overview: Overview
}
</script>

<script setup lang="ts">
const { overview } = defineProps<Props>()
</script>

<template>
  <div class="space-y-3">
    <UAlert
      v-if="!overview.driverHealthy"
      color="error"
      icon="i-lucide-unplug"
      title="The driver connection is down"
      description="Counts below are the last values read and may be stale."
    />
    <UAlert
      v-else-if="!overview.introspectable"
      color="warning"
      icon="i-lucide-eye-off"
      :title="`The ${overview.driver} driver does not support introspection`"
      :description="overview.driver === 'sync'
        ? 'The sync driver runs handlers inline and has no queue, so there is nothing to list. The Registry tab still works.'
        : 'This driver reports no queue contents. The Registry tab still works.'"
    />
    <UAlert
      v-else-if="overview.capabilities?.history === 'bounded'"
      color="neutral"
      variant="subtle"
      icon="i-lucide-history"
      title="Recent results only"
      description="This driver keeps a bounded, in-process history. Older completed and failed jobs are evicted oldest-first and are not durable."
    />

    <section class="space-y-1">
      <h2 class="text-xs font-semibold uppercase text-muted">Queues</h2>
      <div v-for="q in overview.queues" :key="q.name" class="rounded border border-default p-2 text-sm">
        <div class="flex items-center justify-between">
          <span class="font-medium">{{ q.name }}</span>
          <span class="text-xs text-muted">concurrency {{ q.concurrency }}</span>
        </div>
        <div v-if="q.counts" class="mt-1 flex flex-wrap gap-1">
          <UBadge v-for="(n, state) in q.counts" :key="state" size="sm" variant="subtle">
            {{ state }} {{ n }}
          </UBadge>
        </div>
        <p v-else class="mt-1 text-xs text-muted">counts unavailable for this driver</p>
      </div>
    </section>

    <section class="space-y-1">
      <h2 class="text-xs font-semibold uppercase text-muted">Workers</h2>
      <p v-if="!overview.workers.length" class="text-sm text-muted">
        No workers are registered.
      </p>
      <div v-for="w in overview.workers" :key="w.id" class="rounded border border-default p-2 text-sm">
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono text-xs">{{ w.id }}</span>
          <UBadge :color="w.stale ? 'warning' : 'success'" size="sm" variant="subtle">
            {{ w.stale ? 'stale' : w.state }}
          </UBadge>
        </div>
        <p class="text-xs text-muted">pid {{ w.pid }} · role {{ w.role }} · {{ w.active.length }} active</p>
      </div>
    </section>
  </div>
</template>
```

- [ ] **Step 3: Build `JobsPanel.vue`**

Narrow-panel-first: a card list, not a table. The DevTools frame is a fraction of the viewport,
and a table laid out for 1400px is unusable in it.

```vue
<script lang="ts">
import { ref, watch } from 'vue'
import { api, type JobSummaryView, type JobDetailView } from '../api'
import type { Overview } from '../types'

export interface Props {
  overview: Overview
}

const STATES = ['failed', 'waiting', 'active', 'delayed', 'completed'] as const
</script>

<script setup lang="ts">
const { overview } = defineProps<Props>()

const queue = ref(overview.queues[0]?.name ?? '')
const state = ref<string>('failed')
const items = ref<JobSummaryView[]>([])
const total = ref(0)
const selected = ref<JobDetailView | undefined>()
const error = ref<string | undefined>()

const load = async () => {
  if (!queue.value) return
  try {
    const res = await api.jobs(queue.value, state.value)
    items.value = res.items
    total.value = res.total
    error.value = undefined
  }
  catch (err) { error.value = err instanceof Error ? err.message : String(err) }
}

const open = async (id: string) => {
  selected.value = await api.job(queue.value, id)
}

const retry = async (id: string) => {
  try {
    await api.retry(queue.value, id)
    selected.value = undefined
    await load()
  }
  catch (err) { error.value = err instanceof Error ? err.message : String(err) }
}

watch([queue, state], load, { immediate: true })
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap gap-2">
      <USelect v-model="queue" :items="overview.queues.map(q => q.name)" size="xs" />
      <USelect v-model="state" :items="[...STATES]" size="xs" />
      <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Reload" @click="load" />
    </div>

    <UAlert v-if="error" color="error" :description="error" />

    <p class="text-xs text-muted">{{ total }} job(s)</p>

    <button
      v-for="job in items"
      :key="job.id"
      class="block w-full rounded border border-default p-2 text-left text-sm hover:bg-elevated"
      @click="open(job.id)"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium truncate">{{ job.name }}</span>
        <span class="font-mono text-xs text-muted">{{ job.id }}</span>
      </div>
      <p class="text-xs text-muted">
        attempt {{ job.attemptsMade }}<span v-if="job.attempts"> of {{ job.attempts }}</span>
      </p>
      <p v-if="job.failedReason" class="mt-1 text-xs text-error truncate">{{ job.failedReason }}</p>
    </button>

    <!--
      `:open` takes a BOOLEAN, so binding the selected object directly (an
      earlier draft of this plan did) type-errors and leaves the drawer stuck
      open. The close handler clears the selection, which is what the drawer's
      open state is actually derived from.
    -->
    <USlideover
      :open="Boolean(selected)"
      :title="selected?.name"
      @update:open="(value: boolean) => { if (!value) selected = undefined }"
    >
      <template #body>
        <div v-if="selected" class="space-y-3 text-sm">
          <UButton
            v-if="selected.state === 'failed'"
            size="xs"
            icon="i-lucide-rotate-ccw"
            @click="retry(selected.id)"
          >
            Retry this job
          </UButton>

          <div>
            <h3 class="text-xs font-semibold uppercase text-muted">Payload</h3>
            <pre v-if="selected.payload.ok" class="overflow-auto text-xs">{{ selected.payload.value }}</pre>
            <UAlert
              v-else
              color="error"
              title="This payload could not be decoded"
              :description="selected.payload.error"
            />
          </div>

          <div v-if="selected.failedReason">
            <h3 class="text-xs font-semibold uppercase text-muted">Error</h3>
            <p class="text-xs">{{ selected.failedReason }}</p>
            <pre v-if="selected.stack" class="mt-1 overflow-auto text-xs text-muted">{{ selected.stack }}</pre>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>
```

Note the decode-failure branch renders the error and **not** the raw envelope. Falling back to
displaying raw text would reintroduce the payload-content leak the server's shape-only error
message exists to avoid.

- [ ] **Step 4: Build `RegistryPanel.vue`**

```vue
<script lang="ts">
import { ref, onMounted } from 'vue'
import { api, type RegistryView } from '../api'
</script>

<script setup lang="ts">
const registry = ref<RegistryView | undefined>()
onMounted(async () => { registry.value = await api.registry() })
</script>

<template>
  <div v-if="registry" class="space-y-3">
    <div v-for="job in registry.jobs" :key="job.name" class="rounded border border-default p-2 text-sm">
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium">{{ job.name }}</span>
        <UBadge size="sm" variant="subtle">{{ job.queue }}</UBadge>
      </div>
      <p v-if="job.file" class="font-mono text-xs text-muted truncate">{{ job.file }}</p>
      <div class="mt-1 flex flex-wrap gap-1">
        <UBadge size="sm" :variant="job.hasSchema ? 'subtle' : 'outline'">
          {{ job.hasSchema ? `schema: ${job.schemaVendor}` : 'no schema' }}
        </UBadge>
        <UBadge size="sm" variant="outline">
          attempts {{ job.attempts.value }} ({{ job.attempts.from }})
        </UBadge>
        <UBadge size="sm" variant="outline">
          backoff {{ job.backoff.value.type }} {{ job.backoff.value.delay }}ms ({{ job.backoff.from }})
        </UBadge>
      </div>
    </div>

    <details v-if="registry.generatedTypes">
      <summary class="cursor-pointer text-xs font-semibold uppercase text-muted">Generated types</summary>
      <pre class="mt-1 overflow-auto text-xs">{{ registry.generatedTypes }}</pre>
    </details>
  </div>
</template>
```

- [ ] **Step 5: Wire the panels into `App.vue`**

Replace the temporary `<pre>{{ overview }}</pre>` with a `UTabs` over the three panels, keeping the
existing `error` / `!overview` branches, and add the two remaining defined states:

```vue
      <UAlert
        v-else-if="overview.state === 'absent' || overview.state === 'starting'"
        color="neutral"
        variant="subtle"
        icon="i-lucide-loader"
        title="Concierge is starting"
        description="The supervisor has not finished booting. This panel will populate on its own."
      />
      <UTabs
        v-else
        :items="[
          { label: 'Overview', slot: 'overview' },
          { label: 'Jobs', slot: 'jobs' },
          { label: 'Registry', slot: 'registry' },
        ]"
        size="xs"
      >
        <template #overview><OverviewPanel :overview="overview" /></template>
        <template #jobs><JobsPanel :overview="overview" /></template>
        <template #registry><RegistryPanel /></template>
      </UTabs>
```

The `absent`/`starting` branch is what stops the panel rendering zero jobs during the pre-boot
window, when `getSupervisor()` legitimately returns `undefined`.

- [ ] **Step 6: Build and re-measure**

Run: `pnpm build:client && pnpm vitest run test/unit/client-build.test.ts`

Expected: PASS. If the size budget now fails, re-measure as in Task 6 Step 6 and raise the ceiling
deliberately, recording the new number and why in the same comment. Do not raise it silently.

- [ ] **Step 7: Verify every state by hand**

With `pnpm dev` running, check all five in the DevTools tab:

1. Restart the dev server and open the tab immediately → "Concierge is starting".
2. Default config (`memory`) → the bounded-history notice, queues and workers populated.
3. Set `driver: 'sync'` in `playground/nuxt.config.ts` → the sync-specific explanation, Registry
   still works. Revert.
4. Set `driver: 'bullmq'` with a bad `REDIS_URL` → the connection-down banner.
5. Enqueue a failing job, open it, confirm the decoded payload and stack, click Retry, confirm it
   disappears from `failed` and runs again.

Also narrow the DevTools panel to its minimum width and confirm nothing overflows horizontally.

- [ ] **Step 8: Commit**

```bash
git add client test/unit/client-build.test.ts
git commit -m "feat(client): add the overview, jobs and registry panels"
```

---

## Task 12: One playground build per lifecycle run (#21)

**Files:**
- Create: `test/lifecycle/globalSetup.ts`
- Modify: `vitest.lifecycle.config.ts`
- Modify: `test/lifecycle/retry.test.ts:25-32`, `test/lifecycle/shutdown.test.ts:13-23`

**Interfaces:**
- Produces: a single playground build and a namespaced `REDIS_URL` for the whole lifecycle project.
- Consumes: `namespaceRedisUrl` (`harness.ts:208`).

Both lifecycle files currently run `execSync('pnpm dev:build')` in their own `beforeAll`, because
vitest runs each file's hooks separately. Task 13 adds a third file; fixing this first stops the
cost growing again.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/lifecycle-harness.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('the lifecycle suite builds the playground exactly once', () => {
  it('has no per-file build in any lifecycle test', () => {
    const dir = resolve(import.meta.dirname, '../lifecycle')
    const files = ['retry.test.ts', 'shutdown.test.ts', 'dashboard.test.ts']

    for (const file of files) {
      let source: string
      try { source = readFileSync(resolve(dir, file), 'utf8') }
      catch { continue }

      // The build belongs in globalSetup. A per-file build is invisible in a
      // green run — it only shows up as wall-clock time, which is exactly why
      // it grew to two copies before anyone noticed.
      expect(source, `${file} must not build the playground itself`).not.toMatch(/dev:build/)
    }
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run test/unit/lifecycle-harness.test.ts`

Expected: FAIL for both `retry.test.ts` and `shutdown.test.ts`.

- [ ] **Step 3: Create the global setup**

`test/lifecycle/globalSetup.ts`:

```ts
import { execSync } from 'node:child_process'
import { namespaceRedisUrl } from './harness'

/**
 * Runs once for the whole lifecycle project, replacing the per-file
 * `beforeAll(() => execSync('pnpm dev:build'))` each file used to carry. That
 * cost grew linearly with every new scenario file and was invisible in a green
 * run — it showed up only as wall-clock time.
 *
 * The REDIS_URL namespacing MUST happen here, before the build reads it, so
 * every consumer (the build, flushRedis, and every spawned app) agrees on the
 * dedicated logical database. flushRedis runs FLUSHDB and refuses to run
 * against database 0.
 */
export default function setup() {
  if (process.env.REDIS_URL) {
    process.env.REDIS_URL = namespaceRedisUrl(process.env.REDIS_URL)
  }
  execSync('pnpm dev:build', { stdio: 'inherit', timeout: 300_000 })
}
```

`vitest.lifecycle.config.ts`:

```ts
export default defineConfig({
  test: {
    include: ['test/lifecycle/**/*.test.ts'],
    globalSetup: ['test/lifecycle/globalSetup.ts'],
    // These spawn real processes on shared ports and shared Redis keys.
    fileParallelism: false,
    hookTimeout: 320_000,
    testTimeout: 120_000,
  },
})
```

- [ ] **Step 4: Strip the per-file builds**

Delete the `execSync('pnpm dev:build', ...)` line and the `namespaceRedisUrl` reassignment from
both `retry.test.ts`'s and `shutdown.test.ts`'s `beforeAll`. Keep everything else in those hooks.
Remove the now-unused `execSync` import from both. `globalSetup` runs in a separate process from
the test files, so the `REDIS_URL` mutation reaches them via the environment — verify this in Step 5
rather than assuming it, and if it does not propagate, keep the `namespaceRedisUrl` call in each
file's `beforeAll` (it is idempotent) and leave only the build in `globalSetup`.

- [ ] **Step 5: Run the lifecycle suite**

Run: `REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle`

Expected: PASS, with exactly one `nuxi build` in the output. Count it — that is the deliverable.

- [ ] **Step 6: Commit**

```bash
git add test/lifecycle vitest.lifecycle.config.ts test/unit/lifecycle-harness.test.ts
git commit -m "test(lifecycle): build the playground once per run

Closes #21."
```

---

## Task 13: Dev-server lifecycle scenario

**Files:**
- Modify: `test/lifecycle/harness.ts`
- Create: `test/lifecycle/dashboard.test.ts`

**Interfaces:**
- Consumes: the API from Tasks 8-10.
- Produces: `spawnDevApp()` on the harness.

The existing harness spawns the **production** output with `NODE_ENV: production`
(`harness.ts:62-85`), and every dashboard route is registered only under `nuxt.options.dev`. So
there is no dashboard in that artifact. This is not a preference: because the dashboard exists only
in dev, **no production-build test can cover any of it**, and without this scenario nothing in the
suite ever loads the real API through a real Nitro server.

- [ ] **Step 1: Write the failing test**

Create `test/lifecycle/dashboard.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnDevApp, waitForReady, cleanup, killAllSpawned, type AppHandle } from './harness'

/**
 * The ONLY end-to-end coverage of the dashboard, and necessarily against a dev
 * server: registration is gated on nuxt.options.dev, so the built output the
 * rest of this suite uses contains no dashboard at all.
 *
 * Also the experiment for the spec's open question about Nitro public-asset
 * fallthrough: if `/_concierge/` did not resolve index.html, or if the asset
 * middleware swallowed `/_concierge/api/*`, the first two cases here fail.
 */
describe('the dev dashboard', () => {
  let app: AppHandle

  beforeAll(async () => {
    app = await spawnDevApp({ driver: 'memory' })
    await waitForReady(app, 120_000)
  }, 180_000)

  afterAll(() => {
    if (app) cleanup(app)
    killAllSpawned()
  })

  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`)
    return { status: res.status, body: await res.text() }
  }

  it('serves the SPA index at /_concierge/', async () => {
    const res = await get('/_concierge/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('<div id="app">')
  })

  it('serves the API alongside the static assets without either shadowing the other', async () => {
    const res = await get('/_concierge/api/overview')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { driver: string, introspectable: boolean }
    // The discriminating pair: HTML here would mean the public-asset middleware
    // swallowed the API route, which is the exact silent mis-resolution the
    // spec flagged as presenting like an empty panel.
    expect(body.driver).toBe('memory')
    expect(body.introspectable).toBe(true)
  })

  it('shows a failed job, retries it, and the job runs again', async () => {
    await fetch(`http://127.0.0.1:${app.port}/api/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 1, durationMs: 0, fail: true }),
    })

    const listUrl = '/_concierge/api/queues/default/jobs?state=failed'
    let failed: { items: Array<{ id: string, failedReason?: string }> } = { items: [] }
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && failed.items.length === 0) {
      failed = JSON.parse((await get(listUrl)).body)
      if (!failed.items.length) await new Promise(r => setTimeout(r, 250))
    }

    expect(failed.items.length).toBeGreaterThan(0)
    const id = failed.items[0]!.id

    const detail = JSON.parse((await get(`/_concierge/api/queues/default/jobs/${id}`)).body) as {
      payload: { ok: boolean }
    }
    // Decoded server-side, so the SPA never sees a devalue string.
    expect(detail.payload.ok).toBe(true)

    const retried = await fetch(
      `http://127.0.0.1:${app.port}/_concierge/api/queues/default/jobs/${id}/retry`,
      { method: 'POST' },
    )
    expect(retried.status).toBe(204)

    // It left `failed`. Asserting only "204 returned" would pass on a retry
    // endpoint that does nothing at all.
    let stillFailed = true
    const retryDeadline = Date.now() + 30_000
    while (Date.now() < retryDeadline && stillFailed) {
      const now = JSON.parse((await get(listUrl)).body) as { items: Array<{ id: string }> }
      stillFailed = now.items.some(j => j.id === id)
      if (stillFailed) await new Promise(r => setTimeout(r, 250))
    }
    expect(stillFailed).toBe(false)
  }, 90_000)
})
```

The `fail: true` body field requires `playground/server/api/enqueue.post.ts` to route to the
existing `failing` job. Read that file first; if it does not accept such a flag, add one in the
same shape its existing `count`/`durationMs`/`offset` fields use, and commit that change with this
task.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run --config vitest.lifecycle.config.ts test/lifecycle/dashboard.test.ts`

Expected: FAIL — `spawnDevApp is not a function`.

- [ ] **Step 3: Add `spawnDevApp` to the harness**

```ts
export interface SpawnDevOptions {
  driver?: 'memory' | 'bullmq'
  port?: number
  logPath?: string
}

/**
 * Spawns `nuxi dev playground` rather than the built output.
 *
 * Necessary, not preferred: every dashboard route is registered only under
 * `nuxt.options.dev`, so the production artifact `spawnApp` runs contains no
 * dashboard to test. NODE_ENV is left at development for the same reason —
 * forcing production here would gate off the very routes under test.
 *
 * Readiness takes far longer than for the built output (Vite must compile the
 * app on first request), so callers should pass a generous timeout to
 * waitForReady.
 */
export const spawnDevApp = async (opts: SpawnDevOptions = {}): Promise<AppHandle> => {
  const port = opts.port ?? 3600 + Math.floor(Math.random() * 300)
  const logPath = opts.logPath ?? join(tmpdir(), `concierge-dev-${randomUUID()}.log`)
  if (!opts.logPath) writeFileSync(logPath, '')

  const proc = spawn('pnpm', ['dev', '--port', String(port)], {
    env: {
      ...process.env,
      PORT: String(port),
      NITRO_PORT: String(port),
      CONCIERGE_ROLE: 'both',
      CONCIERGE_TEST_LOG: logPath,
      NUXT_CONCIERGE_DRIVER: opts.driver ?? 'memory',
      // Deliberately NOT production: see the doc comment above.
      NODE_ENV: 'development',
      VITEST: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  spawned.add(proc)
  proc.once('exit', () => spawned.delete(proc))

  let stdout = ''
  let stderr = ''
  proc.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString()
    if (process.env.HARNESS_DEBUG) console.log(`[dev] ${d}`)
  })
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
    if (process.env.HARNESS_DEBUG) console.error(`[dev] ${d}`)
  })

  return {
    proc,
    port,
    logPath,
    stop: () => { try { proc.kill('SIGKILL') } catch { /* already gone */ } },
    getStdout: () => stdout,
    getStderr: () => stderr,
  }
}
```

`pnpm dev` runs `nuxi dev playground`, whose child processes must also die on `stop()`. If
`SIGKILL` to the `pnpm` wrapper leaves a `nuxi` child running (visible as a port still bound after
the suite finishes), spawn with `detached: true` and kill the process group with
`process.kill(-proc.pid!, 'SIGKILL')`. Verify which is needed in Step 4 rather than guessing — a
leaked dev server holding a port is exactly the pollution `killAllSpawned` exists to prevent.

- [ ] **Step 4: Run it**

Run: `pnpm vitest run --config vitest.lifecycle.config.ts test/lifecycle/dashboard.test.ts`

Expected: PASS, all three cases. Then confirm no process is left behind:
`lsof -i :3600-3900 | head` should be empty.

- [ ] **Step 5: Run the whole lifecycle suite**

Run: `REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle`

Expected: PASS. The dev-server file does not need the `globalSetup` build, but must not break it.

- [ ] **Step 6: Record the public-assets outcome in the spec**

Update the spec's "Process shape and route table" section: replace the "one unverified assumption"
paragraph with what the passing test proved, or with the fallback that was needed.

- [ ] **Step 7: Commit**

```bash
git add test/lifecycle playground/server/api/enqueue.post.ts \
  specs/2026-08-13-concierge-v2-dashboard-design.md
git commit -m "test(lifecycle): end-to-end dashboard scenario against a dev server"
```

---

## Task 14: Close out — typecheck coverage, CI, and docs

**Files:**
- Modify: `test/types/tsconfig.json` or `package.json` (#26)
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `specs/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the shipping gates.

- [ ] **Step 1: Bring `test/unit/module.test.ts` under a typecheck (#26)**

Determine which script covers it: `pnpm typecheck` runs `nuxi typecheck playground` and
`typecheck:public` uses `test/types/tsconfig.json`. Neither includes `test/unit`. Add a
`tsc --noEmit` project that does:

```json
    "typecheck:tests": "tsc --noEmit -p test/tsconfig.json",
```

with `test/tsconfig.json` including `test/**/*.ts` and the same strictness as the root config. This
task grew `module.test.ts` substantially, including the mock-heavy registration cases, which is
exactly the code a typecheck catches and a passing runtime test does not.

- [ ] **Step 2: Run it and fix what it finds**

Run: `pnpm typecheck:tests`

Expected: errors in the newly added test files, most likely around the deliberately-minimal fake
`Nuxt` objects. Fix with `as unknown as X` casts plus a comment naming what is deliberately partial
— never by loosening the shared config.

- [ ] **Step 3: Wire CI**

In `.github/workflows/ci.yml`, add after `pnpm typecheck:public`:

```yaml
      - run: pnpm typecheck:tests
```

`pnpm dev:prepare` already builds the client after Task 6, so `pnpm test`'s
`client-build.test.ts` has its artifact. Confirm that ordering holds in the workflow; if
`dev:prepare` runs after any step needing `dist/client`, move it earlier rather than adding a
second build.

- [ ] **Step 4: Update the README**

Replace any bull-board / `managementUI` documentation with the DevTools tab, and state plainly:
the dashboard is dev-only, there is no production dashboard, retry is the only write action, and
the `memory` driver's history is bounded by `concierge.memory.historyLimit` (default 100 per queue)
and is not durable. Document `concierge.memory` alongside `concierge.bullmq`.

- [ ] **Step 5: Update the roadmap**

In `specs/README.md`, change spec 4's state from *Designed — plan not yet written* to *Shipped*
with the version, and link the plan alongside the design. Add a spec 4 decisions record entry to
the "Read before starting" guidance.

- [ ] **Step 6: Full gate**

Run:

```bash
pnpm lint && pnpm typecheck && pnpm typecheck:public && pnpm typecheck:tests \
  && pnpm test:types && REDIS_URL=redis://127.0.0.1:6379 pnpm test \
  && REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle && pnpm prepack
```

Expected: all PASS. `prepack` last, because it is what proves the published artifact contains
`dist/client`.

- [ ] **Step 7: Verify the tarball actually contains the SPA**

Run: `npm pack --dry-run 2>&1 | grep -c 'dist/client'`

Expected: a non-zero count. A published tarball with no `dist/client` gives every consumer a 404 at
the DevTools tab, and nothing else in this plan would catch it.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: typecheck test sources, wire CI, and document the dashboard

Closes #26."
```

---

## After the plan

Write a **spec 4 decisions record** at `specs/2026-08-13-spec4-decisions.md`, in the same shape as
the phase 1 and spec 3 records: constraints that break the build or silently break behaviour,
corrections to earlier claims, known gaps deliberately carried with their issue numbers, facts that
cost real time, and test-suite conventions established. Both prior records proved to be the highest
-value artifact of their spec, and several items in this plan exist only because those records
recorded them.

Two things already known to belong in it:

- **Registration-time gating is the security boundary.** There is deliberately no runtime flag that
  enables the dashboard in production. Anyone "helpfully" adding one has removed the reason this
  spec needs no auth.
- **The dev-server lifecycle scenario is the only end-to-end coverage that can exist**, because the
  feature exists only in dev. If it becomes flaky, fix it rather than skipping it — skipping it
  removes all end-to-end signal for the module's most user-visible feature.
