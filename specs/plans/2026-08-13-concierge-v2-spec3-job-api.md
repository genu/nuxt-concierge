# nuxt-concierge Spec 3 — Job API, Typed Enqueue and Payload Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `enqueue` know every job's payload type at compile time, reject payloads that do not match on both sides of the queue, and give the three drivers a retry contract they actually agree on.

**Architecture:** `defineJob` gains two overloads — one where the payload type comes from an explicit type argument, one where it comes from a Standard Schema `input`. A generated ambient declaration merges a `ConciergeJobMap` interface into the existing `#concierge` module declaration, keyed by scanned job name and valued by `typeof import('<job file>')['default']`, which makes `useQueue().enqueue` generic over it. Validation runs twice: the producer validates and **discards** the result purely to fail fast, and the consumer validates and **keeps** the result, so a transforming schema runs exactly once in the process whose schema is authoritative. Job modules are still imported eagerly, exactly as in phase 1.

**Tech Stack:** Nuxt 3/4 module (`@nuxt/kit`), Nitro plugins and type templates, BullMQ + ioredis, `@standard-schema/spec`, zod (tests/playground only), vitest including `--typecheck`.

**Spec:** `specs/2026-08-13-concierge-v2-job-api-design.md`

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec and from `specs/2026-08-13-phase1-decisions.md`.

- **Node:** `>=22`. **Nuxt compatibility:** `^3.0.0 || ^4.0.0`.
- **All dependencies pinned** — no `^` or `~` ranges in `package.json`. New: `@standard-schema/spec` at `1.1.0` (dependencies), `zod` at `4.4.3` (devDependencies).
- **Resolve scan paths against `nuxt.options.rootDir`, never `srcDir`.** In Nuxt 4 `srcDir` defaults to `app/`, so resolving against it yields `app/server/jobs`, which does not exist — the scan returns `[]` and raises nothing.
- **The generated `0.concierge-nuxt-plugin.ts` is parsed as plain JavaScript** by a pre-TypeScript stage of nitro's rollup pipeline. Zero TypeScript syntax may enter it: no type annotations, no `import type`, no `as` casts, no generics. This plan only adds object-literal fields to its `jobs` array.
- **Never import `defineNitroPlugin` from `#imports`** in a generated nitro plugin.
- **Never use devalue `uneval`.** `stringify`/`parse` only.
- **`attempts` is total attempts including the first**, matching BullMQ. Never convert between "attempts" and "retries".
- **Retry defaults:** `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`.
- **Exponential backoff for the k-th retry is `Math.round(2 ** (k - 1) * delay)`** (`bullmq@5.63.0`, `dist/esm/classes/backoffs.js`). Task 11 must confirm the value of `k` BullMQ actually passes against real Redis before the memory driver copies it.
- **Delivery guarantee is at-least-once.** Never write a test asserting zero duplicates. Duplicates are counted and bounded.
- **Consumer-side validation error messages must contain issue paths and counts only, never issue messages.** That text becomes BullMQ's `failedReason`, which is persisted in Redis and logged, and Standard Schema issue messages can embed received values.
- **Type templates that declare nitro-only modules need `{ nitro: true }`** — and, per Task 4, a second app-graph copy, because Nitro's `nitro-routes.d.ts` drags server handlers into the app program.
- **Every assertion must fail if the behaviour under test is removed.** The single most repeated defect in phase 1 was assertions that could not fail — eight instances, two of them introduced by fixes for earlier ones.

## File Structure

**Created:**

| Path | Responsibility |
| ---- | -------------- |
| `src/runtime/server/validate.ts` | `JobPayloadInvalidError`, `validateOnEnqueue`, `validateOnConsume` |
| `vitest.types.config.ts` | Vitest config running `--typecheck` over `test/types/**` |
| `test/types/tsconfig.json` | tsconfig for the type-test project |
| `test/types/defineJob.test-d.ts` | Type assertions for the `defineJob` overloads |
| `test/types/enqueue.test-d.ts` | Type assertions for the generated map and `enqueue` |
| `test/unit/validate.test.ts` | Validation, redaction and permanent-failure classification |
| `test/unit/retry-conformance.test.ts` | One shared retry table run against `memory` and `bullmq` |
| `test/lifecycle/retry.test.ts` | Retry across a real drain; invalid payload dead-letters |
| `playground/server/jobs/typed.ts` | A job with a zod `input`, exercising transform-once end to end |

**Modified:** `src/options.ts`, `src/module.ts`, `src/templates.ts`, `src/scan.ts` (no logic change; export reuse), `src/runtime/server/types.ts`, `src/runtime/server/handlers/defineJob.ts`, `src/runtime/server/utils/useQueue.ts`, `src/runtime/server/supervisor.ts`, `src/runtime/server/drivers/types.ts`, `src/runtime/server/drivers/bullmq.ts`, `src/runtime/server/drivers/memory.ts`, `src/runtime/server/routes/ui-handler.ts`, `test/unit/defineJob.test.ts`, `test/unit/supervisor.test.ts`, `playground/nuxt.config.ts`, `playground/server/jobs/slow.ts`, `playground/server/api/enqueue.post.ts`, `package.json`, `.github/workflows/ci.yml`, `README.md`, `CHANGELOG.md`.

---

## Part A — Make `typecheck` green and gate it in CI (Tasks 1–4)

`pnpm typecheck` currently reports **12 errors** and does not run in CI. This spec's entire deliverable is types, and phase 1's 175 runtime tests would all still pass if codegen emitted `any` for every job. Part A is therefore a prerequisite, not a cleanup.

Reproduce the baseline before starting:

```bash
pnpm dev:prepare
pnpm typecheck 2>&1 | grep -cE "error TS"   # expect: 12
```

---

### Task 1: Fix the ioredis connection-type cluster (7 of 12 errors)

`src/runtime/server/drivers/bullmq.ts:32` declares:

```ts
type RedisConnectionOptions = ConstructorParameters<typeof Redis>[0]
```

`Redis` has 8 constructor overloads and `ConstructorParameters` resolves to the **last** one, which takes no arguments — so the tuple is `[]`, index `0` is an error (`TS2493`), and the alias silently becomes `undefined`. Every `as RedisConnectionOptions` in the file is therefore `as undefined`, producing six further errors at lines 95, 107 and 200.

ioredis exports the correct type directly (`ioredis@5.11.1`, `built/index.d.ts:34`), and BullMQ's `ConnectionOptions` is a union that already includes it (`bullmq@5.63.0`, `dist/esm/interfaces/redis-options.d.ts:8`: `RedisOptions | ClusterOptions | IORedis.Redis | IORedis.Cluster`).

**Files:**
- Modify: `src/runtime/server/drivers/bullmq.ts:1-3` (imports), `:26-32` (the alias)
- Test: `test/unit/drivers/bullmq-mapping.test.ts` (existing; must stay green)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no signature changes. `RedisConnectionOptions` is removed as a name; call sites use `RedisOptions` imported from `ioredis`.

- [ ] **Step 1: Confirm the baseline failure and its count**

Run:
```bash
pnpm typecheck 2>&1 | grep -E "bullmq\.ts.*error TS" | wc -l
```
Expected: `7`

- [ ] **Step 2: Replace the broken alias with ioredis's own type**

In `src/runtime/server/drivers/bullmq.ts`, change the import on line 2 and delete the alias block at lines 26–32.

```ts
import { Redis } from 'ioredis'
import type { RedisOptions } from 'ioredis'
```

Delete this entire block:

```ts
/**
 * BullMQ's `redisOptions` shape overlaps with, but is not identical to,
 * ioredis's constructor options. The connection we build here only ever
 * carries `url`/`host`/`port`/`password`, all of which are valid for both, so
 * the cast is narrow and safe rather than a blanket `any`.
 */
type RedisConnectionOptions = ConstructorParameters<typeof Redis>[0]
```

and replace it with:

```ts
/**
 * ioredis's own options type, NOT `ConstructorParameters<typeof Redis>[0]`.
 * `Redis` has eight constructor overloads and `ConstructorParameters` picks
 * the LAST one, which takes no arguments — so that alias resolved to `[]`,
 * index 0 was a TS2493 error, and the alias silently became `undefined`.
 * Every cast through it therefore became `as undefined`, which is how one bad
 * type alias produced seven of the twelve pre-existing typecheck errors.
 *
 * BullMQ's own `ConnectionOptions` is a union that already includes this type
 * (`bullmq/dist/esm/interfaces/redis-options.d.ts`), so the same type serves
 * both the `new Redis(...)` and the `{ connection }` call sites below.
 */
type RedisConnectionOptions = RedisOptions
```

- [ ] **Step 3: Verify all seven errors are gone and no new ones appeared**

Run:
```bash
pnpm typecheck 2>&1 | grep -E "bullmq\.ts.*error TS" | wc -l   # expect: 0
pnpm typecheck 2>&1 | grep -cE "error TS"                      # expect: 5
```

- [ ] **Step 4: Verify the runtime suite is unaffected**

Run: `pnpm test`
Expected: PASS, same test count as before this task (the change is type-only).

- [ ] **Step 5: Verify the lifecycle suite still connects to real Redis**

Run: `REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle`
Expected: PASS. This matters because the cast feeds the actual `new Redis(...)` and `new Queue(...)` calls — a type-only change that broke connection construction would show up here and nowhere else.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/server/drivers/bullmq.ts
git commit -m "fix: use ioredis RedisOptions instead of a ConstructorParameters alias

ConstructorParameters<typeof Redis>[0] resolves to the last of eight
constructor overloads, which takes no arguments, so the alias was []
indexed at 0 — a TS2493 error that silently degraded to undefined and
turned every cast through it into 'as undefined'. One bad alias
accounted for 7 of the 12 pre-existing typecheck errors."
```

---

### Task 2: Fix `ui-handler.ts` (3 of 12 errors)

Three unrelated errors in one file. Spec 4 replaces this file wholesale, so the goal is minimum correct change, not redesign.

1. `:8` — `TS2305: Module '"#imports"' has no exported member 'useNitroApp'`. It is not part of nitro's auto-import surface for a module runtime file.
2. `:9` — `TS2307: Cannot find module '#concierge/supervisor'`. The alias is registered in `nitro:config` (`src/templates.ts:193-202`) but never declared to TypeScript.
3. `:46` — `TS2322: BullMQAdapter[] is not assignable to readonly BaseAdapter[]`. `@bull-board/api@5.14.0` was built against an older BullMQ whose `toJSON().progress` was `number | object`; `bullmq@5.63.0` widened `JobProgress` to include `string`.

**Files:**
- Modify: `src/runtime/server/routes/ui-handler.ts:1-15`, `:40-50`
- Modify: `src/templates.ts` (add type declarations for the `#concierge/*` aliases)
- Modify: `package.json` (bump `@bull-board/*`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a new exported template function `createTemplateInternalTypes()` in `src/templates.ts`, called from `src/module.ts`. It emits `types/concierge-internal.d.ts` declaring `#concierge/role`, `#concierge/supervisor`, `#concierge/shutdown` and `#concierge/guardrails`.

- [ ] **Step 1: Confirm the baseline**

Run:
```bash
pnpm typecheck 2>&1 | grep -E "ui-handler\.ts.*error TS"
```
Expected: exactly three lines, at `(8,10)`, `(9,31)` and `(46,5)`.

- [ ] **Step 2: Fix the `useNitroApp` import**

In `src/runtime/server/routes/ui-handler.ts`, replace the `#imports` import of `useNitroApp` with nitro's own runtime specifier:

```ts
import { useNitroApp } from 'nitropack/runtime'
```

Leave every other import on that line (`defineEventHandler`, etc.) importing from `#imports` as before.

- [ ] **Step 3: Run typecheck to confirm error 1 is fixed and see what remains**

Run:
```bash
pnpm typecheck 2>&1 | grep -E "ui-handler\.ts.*error TS"
```
Expected: two lines remain, at `(9,31)` and `(46,5)`.

- [ ] **Step 4: Declare the `#concierge/*` internal aliases to TypeScript**

Add this function to `src/templates.ts`, after `createTemplateType`:

```ts
/**
 * Declares the `#concierge/*` aliases that `nitro:config` registers (see
 * `createTemplateType` below). Those aliases resolve at BUILD time but were
 * invisible to TypeScript, which is why `ui-handler.ts`'s import of
 * `#concierge/supervisor` was a TS2307 error.
 *
 * Emitted for the nitro graph only: unlike `#concierge`, these are genuinely
 * internal and no server ROUTE imports them, so nothing drags them into the
 * app program the way `nitro-routes.d.ts` does for `#concierge` (see Task 4).
 */
export const createTemplateInternalTypes = () => {
  const { resolve } = createResolver(import.meta.url);

  const modules = {
    "#concierge/role": "./runtime/server/role",
    "#concierge/supervisor": "./runtime/server/supervisor",
    "#concierge/shutdown": "./runtime/server/shutdown",
    "#concierge/guardrails": "./runtime/server/guardrails",
  };

  const declarations = Object.entries(modules)
    .map(
      ([specifier, path]) =>
        `  declare module "${specifier}" {\n` +
        `    export * from "${resolve(path)}";\n` +
        `  }`
    )
    .join("\n");

  addTypeTemplate(
    {
      filename: "types/concierge-internal.d.ts",
      write: true,
      getContents: () => declarations,
    },
    { nitro: true }
  );
};
```

- [ ] **Step 5: Call it from the module**

In `src/module.ts`, update the import on line 18 and the call site on line 66.

```ts
import {
  createTemplateNuxtPlugin,
  createTemplateType,
  createTemplateInternalTypes,
} from "./templates";
```

```ts
    createTemplateType();
    createTemplateInternalTypes();
```

- [ ] **Step 6: Regenerate and confirm error 2 is fixed**

Run:
```bash
pnpm dev:prepare
pnpm typecheck 2>&1 | grep -E "ui-handler\.ts.*error TS"
```
Expected: one line remains, at `(46,5)`.

- [ ] **Step 7: Bump BullBoard to a build that matches bullmq 5.63**

Run:
```bash
pnpm add -E @bull-board/api@6.14.0 @bull-board/h3@6.14.0 @bull-board/ui@6.14.0
pnpm dev:prepare
pnpm typecheck 2>&1 | grep -E "ui-handler\.ts.*error TS" | wc -l
```
Expected: `0`.

If the bump does **not** clear it (the adapter's BullMQ peer range may still lag), do not leave the error and do not widen the cast blindly. Add this narrowly-scoped, documented cast at the `createBullBoard` call in `src/runtime/server/routes/ui-handler.ts` instead, and record the reason:

```ts
      // @bull-board/api types `queues` as readonly BaseAdapter[], whose
      // QueueJob requires `toJSON().progress: number | object`. bullmq 5.63
      // widened JobProgress to include `string`, so BullMQAdapter no longer
      // structurally satisfies it even though the runtime behaviour is
      // unchanged. Cast confined to this one argument rather than the
      // adapters themselves. Spec 4 replaces this file wholesale.
      queues: adapters as unknown as Parameters<typeof createBullBoard>[0]["queues"],
```

- [ ] **Step 8: Verify the dashboard still renders**

Run: `pnpm dev` and open `http://localhost:3000/_concierge`.
Expected: the BullBoard UI loads and lists the `default` queue. A type-only fix that broke the adapter wiring would produce a blank frame or a 500 here, which typecheck cannot see.

Stop the dev server before continuing.

- [ ] **Step 9: Confirm the remaining error count**

Run: `pnpm typecheck 2>&1 | grep -cE "error TS"`
Expected: `2` (the `nuxt.config.ts` and `enqueue.post.ts` errors, fixed in Tasks 3 and 4).

- [ ] **Step 10: Commit**

```bash
git add src/runtime/server/routes/ui-handler.ts src/templates.ts src/module.ts package.json pnpm-lock.yaml
git commit -m "fix: resolve ui-handler typecheck errors

- useNitroApp comes from nitropack/runtime, not #imports
- declare the #concierge/* aliases that nitro:config registers, which
  resolved at build time but were invisible to TypeScript
- bump @bull-board to a build matching bullmq 5.63, whose JobProgress
  now includes string"
```

---

### Task 3: Make `ModuleOptions` accept partial nested config (1 of 12 errors)

`playground/nuxt.config.ts:33` sets `worker: { queues, shutdownTimeout }` and fails with `TS2739: missing the following properties from type 'WorkerOptions': heartbeatInterval, heartbeatTtl`.

**This is a public API defect, not a playground problem.** `moduleDefaults` supplies those fields via `defu`, so any user who configures `worker` partially — the normal case — hits the same error. Fixing it in the playground config would hide it from us while leaving it for every consumer.

The fix splits the input type from the resolved type: `ModuleOptions` is what a user writes (everything optional), `ResolvedModuleOptions` is what the runtime receives after `defu`.

**Files:**
- Modify: `src/options.ts` (whole file)
- Modify: `src/module.ts:33` (setup signature), `:80-83`, `:114-118`
- Modify: `src/runtime/server/supervisor.ts:11-33` (`SupervisorConfig` reuses the resolved type)
- Test: `test/unit/options.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ModuleOptions` — all fields optional, nested objects `Partial`. This is the type `defineNuxtModule<ModuleOptions>` is parameterised with and therefore what `nuxt.config.ts` typechecks against.
  - `ResolvedModuleOptions` — all fields required, nested objects complete.
  - `resolveModuleOptions(options: ModuleOptions): ResolvedModuleOptions` — pure, `defu`-based.
  - `moduleDefaults: ResolvedModuleOptions` — unchanged name, now typed as resolved.

- [ ] **Step 1: Write the failing test**

Create `test/unit/options.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { moduleDefaults, resolveModuleOptions } from '../../src/options'

describe('resolveModuleOptions', () => {
  it('fills every worker field when the user supplies only one', () => {
    const resolved = resolveModuleOptions({ worker: { queues: { mail: 2 } } })

    expect(resolved.worker.queues).toEqual({ mail: 2 })
    expect(resolved.worker.shutdownTimeout).toBe(moduleDefaults.worker.shutdownTimeout)
    expect(resolved.worker.heartbeatInterval).toBe(moduleDefaults.worker.heartbeatInterval)
    expect(resolved.worker.heartbeatTtl).toBe(moduleDefaults.worker.heartbeatTtl)
  })

  it('does not merge the user queue map into the default one', () => {
    // defu merges objects by default, which would leave the `default` queue
    // declared even though the user replaced the map — and a stray declared
    // queue silently starts a consumer for work that never arrives.
    const resolved = resolveModuleOptions({ worker: { queues: { mail: 2 } } })

    expect(Object.keys(resolved.worker.queues)).toEqual(['mail'])
  })

  it('fills every bullmq field when the user supplies only one', () => {
    const resolved = resolveModuleOptions({ bullmq: { stalledInterval: 1000 } })

    expect(resolved.bullmq.stalledInterval).toBe(1000)
    expect(resolved.bullmq.maxStalledCount).toBe(moduleDefaults.bullmq.maxStalledCount)
  })

  it('returns the defaults verbatim for empty input', () => {
    expect(resolveModuleOptions({})).toEqual(moduleDefaults)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/options.test.ts`
Expected: FAIL — `resolveModuleOptions` is not exported from `src/options.ts`.

- [ ] **Step 3: Rewrite `src/options.ts`**

```ts
import defu from 'defu'
import type { Role } from './runtime/server/types'
import type { BackoffOptions } from './runtime/server/types'

export type DriverName = 'auto' | 'sync' | 'memory' | 'bullmq'

export interface ConnectionOptions {
  url?: string
  host?: string
  port?: number
  password?: string
}

export interface WorkerOptions {
  /**
   * Queue name -> concurrency. Does double duty: it is both the concurrency
   * map and the queue declaration, since defineQueue is gone. A job naming a
   * queue absent from this map is a boot-time error.
   */
  queues: Record<string, number>
  /** Must stay strictly below NITRO_SHUTDOWN_TIMEOUT (default 30_000). */
  shutdownTimeout: number
  heartbeatInterval: number
  heartbeatTtl: number
}

export interface BullmqOptions {
  /** BullMQ's default is 1, which fails a job permanently after two force-closes. */
  maxStalledCount: number
  /** Configurable because a force-closed job is not retried until it elapses. */
  stalledInterval: number
}

/** Retry policy applied to any job that does not declare its own. */
export interface JobDefaults {
  /** TOTAL attempts including the first, matching BullMQ. */
  attempts: number
  backoff: BackoffOptions
}

/**
 * What a user writes in `nuxt.config.ts`. Every field is optional and nested
 * objects are `Partial`, because `resolveModuleOptions` fills the gaps from
 * `moduleDefaults`.
 *
 * This used to be the fully-required shape, which meant `worker: { queues }`
 * — the normal case — failed to typecheck with "missing the following
 * properties: heartbeatInterval, heartbeatTtl". The resolved shape is
 * `ResolvedModuleOptions` below.
 */
export interface ModuleOptions {
  driver?: DriverName
  connection?: ConnectionOptions
  role?: Role
  worker?: Partial<WorkerOptions>
  bullmq?: Partial<BullmqOptions>
  defaults?: Partial<JobDefaults>
  /** BullBoard dashboard. Unchanged in phase 1; replaced in spec 4. */
  managementUI?: boolean
}

/** What the runtime receives, after defaults are applied. */
export interface ResolvedModuleOptions {
  driver: DriverName
  connection: ConnectionOptions
  role?: Role
  worker: WorkerOptions
  bullmq: BullmqOptions
  defaults: JobDefaults
  managementUI?: boolean
}

export const moduleDefaults: ResolvedModuleOptions = {
  driver: 'auto',
  connection: { url: process.env.REDIS_URL },
  role: undefined,
  worker: {
    queues: { default: 5 },
    shutdownTimeout: 20_000,
    heartbeatInterval: 5_000,
    heartbeatTtl: 15_000,
  },
  bullmq: {
    maxStalledCount: 3,
    stalledInterval: 30_000,
  },
  defaults: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
  managementUI: process.env.NODE_ENV === 'development',
}

export const resolveModuleOptions = (options: ModuleOptions): ResolvedModuleOptions => {
  const merged = defu(options, moduleDefaults) as ResolvedModuleOptions

  return {
    ...merged,
    worker: {
      ...merged.worker,
      // REPLACED, not merged. defu merges objects, so a user declaring
      // `queues: { mail: 2 }` would keep the default `default: 5` as well —
      // starting a consumer for a queue they never declared, and making the
      // no-worker guardrail watch a queue nothing enqueues to.
      queues: options.worker?.queues ?? moduleDefaults.worker.queues,
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/options.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Update `src/module.ts` to resolve options once**

Change the import on line 20 and the two `defu` blocks.

```ts
import { moduleDefaults, resolveModuleOptions } from "./options";
```

Replace the block at lines 80–83:

```ts
    const resolved = resolveModuleOptions(options);

    nuxt.options.runtimeConfig.concierge = defu(
      nuxt.options.runtimeConfig.concierge,
      resolved
    );
```

and, in the block at lines 114–118, use `resolved` in place of `options`:

```ts
    nuxt.options.runtimeConfig.concierge = defu(
      { role, version: packageVersion ?? "unknown", isDev, isProduction: !isDev },
      nuxt.options.runtimeConfig.concierge,
      resolved
    );
```

Also change the `resolveRole` call at line 85–89 to read from `resolved`:

```ts
    const role = resolveRole({
      env: process.env.CONCIERGE_ROLE,
      config: resolved.role,
      isDev: nuxt.options.dev,
    });
```

- [ ] **Step 6: Point `SupervisorConfig` at the resolved type**

In `src/runtime/server/supervisor.ts`, replace the hand-written duplicate fields in `SupervisorConfig` (lines 11–33) with a reference to the resolved options, keeping the `isProduction` comment verbatim:

```ts
export interface SupervisorConfig {
  role: Role
  driver: DriverName
  connection: ConnectionOptions
  bullmq: BullmqOptions
  worker: WorkerOptions
  defaults: JobDefaults
  jobs: JobDefinition[]
  version: string
  /**
   * Resolved at build time by the host module, not read from process.env at
   * runtime here: Nitro's production bundling statically inlines
   * `process.env.NODE_ENV`, which freezes an `auto` driver's guardrail
   * decision into the built artifact with no runtime escape hatch. Reading
   * it off runtimeConfig instead keeps it overridable via the standard
   * NUXT_CONCIERGE_IS_PRODUCTION env var.
   */
  isProduction: boolean
}
```

and add the import:

```ts
import type {
  BullmqOptions,
  ConnectionOptions,
  DriverName,
  JobDefaults,
  WorkerOptions,
} from '../../options'
```

- [ ] **Step 7: Verify the `nuxt.config.ts` error is gone**

Run:
```bash
pnpm dev:prepare
pnpm typecheck 2>&1 | grep -cE "error TS"
```
Expected: `1` (only `enqueue.post.ts` remains).

- [ ] **Step 8: Run the full unit suite**

Run: `pnpm test`
Expected: PASS. `test/unit/supervisor.test.ts` constructs `SupervisorConfig` objects directly; if it now fails to compile or run, add `defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` to those fixtures rather than loosening the type.

- [ ] **Step 9: Commit**

```bash
git add src/options.ts src/module.ts src/runtime/server/supervisor.ts test/unit/options.test.ts test/unit/supervisor.test.ts
git commit -m "fix!: accept partial nested module options

ModuleOptions required every nested field, so 'worker: { queues }' — the
normal case — failed to typecheck with 'missing heartbeatInterval,
heartbeatTtl'. Splits the user-facing input type from the resolved type
and adds resolveModuleOptions(). Also introduces concierge.defaults,
consumed by Task 10.

The queue map is replaced rather than defu-merged: merging left the
default queue declared alongside a user's own, starting a consumer for a
queue nothing enqueues to."
```

---

### Task 4: Fix `#concierge` in the app program, then gate typecheck in CI (1 of 12 errors)

`playground/server/api/enqueue.post.ts:2` fails with `TS2307: Cannot find module '#concierge'`, even though the module resolves correctly inside the server project. Verified chain:

```
.nuxt/nuxt.d.ts (app project)
  → types/nitro.d.ts
    → types/nitro-routes.d.ts
      → typeof import('../../server/api/enqueue.post')   ← pulls the handler into the APP program
```

Nitro types `$fetch` by referencing every server route handler, which drags those handlers into the app program — where `#concierge` is undeclared because `createTemplateType` correctly scopes it with `{ nitro: true }` (`src/templates.ts:205`).

**The consequence is on the happy path: any API route that enqueues a job and returns a value fails typecheck.** That is the library's primary documented usage. Phase 1 observed this error but did not diagnose it — it is one of the 12 "reported and unfixed".

The tradeoff, stated plainly: emitting `#concierge` into the app graph as well restores the client-typings footgun that `{ nitro: true }` was added to prevent — client code importing `useQueue` would typecheck and then fail when the client bundler cannot resolve the alias. That footgun fails loudly at build time and is visible in review. Breaking correct server code is worse than failing to prevent incorrect client code, so this task emits both copies.

**Files:**
- Modify: `src/templates.ts` (`createTemplateType` emits twice)
- Modify: `.github/workflows/ci.yml` (add the typecheck step)
- Modify: `package.json` (no new script; `typecheck` already exists)

**Interfaces:**
- Consumes: `createTemplateInternalTypes` from Task 2 (unchanged; stays nitro-only).
- Produces: `createTemplateType()` now emits `types/concierge.d.ts` **and** `types/concierge-app.d.ts` with identical contents, the second without `{ nitro: true }`. Task 12 extends the same function with the job map and must emit both copies too.

- [ ] **Step 1: Confirm the failure and that it is app-graph-only**

Run:
```bash
pnpm typecheck 2>&1 | grep "enqueue.post"
cd playground && ../node_modules/.bin/vue-tsc --noEmit -p server/tsconfig.json 2>&1 | grep "enqueue.post" || echo "resolves fine in the server project"; cd ..
```
Expected: the first command reports `TS2307`; the second prints `resolves fine in the server project`. That contrast is the whole diagnosis — the alias is declared, just not in the graph that Nitro's route typing pulls the handler into.

- [ ] **Step 2: Emit the `#concierge` declaration into both graphs**

In `src/templates.ts`, replace the whole `addTypeTemplate` call for `types/concierge.d.ts` inside `createTemplateType` with:

```ts
  // `#concierge` must be declared in BOTH graphs.
  //
  // The nitro copy is the one that matters for correctness of server code.
  // The app copy exists because nitro generates `types/nitro-routes.d.ts`
  // containing `typeof import('<rootDir>/server/api/foo.post')` for every
  // server route, and `.nuxt/nuxt.d.ts` references it — so every server
  // route handler is pulled into the APP program to compute $fetch's return
  // types. A route that imports `#concierge` (an API route that enqueues a
  // job and returns JSON — the primary documented usage) therefore failed
  // with TS2307 in the app program while resolving fine in the server one.
  //
  // The cost, accepted deliberately: client code importing `useQueue` now
  // typechecks and fails later, at build time, when the client bundler
  // cannot resolve the alias. That footgun is loud and visible in review;
  // breaking correct server code is worse than failing to prevent incorrect
  // client code.
  const conciergeModule = `
  declare module "#concierge" {
    const useQueue: typeof import("${resolve(
      "./runtime/server/utils/useQueue"
    )}").useQueue;
  }
  `;

  addTypeTemplate(
    {
      filename: "types/concierge.d.ts",
      write: true,
      getContents: () => conciergeModule,
    },
    { nitro: true }
  );

  addTypeTemplate({
    filename: "types/concierge-app.d.ts",
    write: true,
    getContents: () => conciergeModule,
  });
```

Leave the `types/concierge-handlers.d.ts` template nitro-only: `defineJob` is imported by job files under `server/jobs/`, which Nitro does not reference from `nitro-routes.d.ts` (they are not routes), so nothing drags them into the app program.

- [ ] **Step 3: Verify typecheck is fully green**

Run:
```bash
pnpm dev:prepare
pnpm typecheck 2>&1 | grep -cE "error TS"
```
Expected: `0`.

- [ ] **Step 4: Verify the fix is load-bearing, not incidental**

Temporarily delete `playground/.nuxt/types/concierge-app.d.ts`, re-run typecheck, and confirm the error returns:

```bash
rm playground/.nuxt/types/concierge-app.d.ts
pnpm typecheck 2>&1 | grep -c "enqueue.post"   # expect: 1
pnpm dev:prepare                                # restore
pnpm typecheck 2>&1 | grep -cE "error TS"      # expect: 0
```

This is the observe-it-failing step. Without it, a green typecheck proves nothing about whether the new template is what made it green.

- [ ] **Step 5: Add the typecheck gate to CI**

In `.github/workflows/ci.yml`, insert a step immediately after `- run: pnpm lint`:

```yaml
      # Gated as of spec 3, whose entire deliverable is types. Twelve errors
      # accumulated while this was unwired, including one that broke the
      # library's primary usage (an API route that enqueues and returns JSON).
      - run: pnpm typecheck
```

- [ ] **Step 6: Verify the whole gate passes locally exactly as CI runs it**

Run:
```bash
pnpm install --frozen-lockfile
pnpm dev:prepare
pnpm lint
pnpm typecheck
pnpm test
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/templates.ts .github/workflows/ci.yml
git commit -m "fix: declare #concierge in the app graph and gate typecheck in CI

Nitro's nitro-routes.d.ts references every server route handler to type
\$fetch, which pulls those handlers into the app program — where
#concierge was undeclared because the template is scoped { nitro: true }.
Any API route that enqueues a job and returns a value therefore failed
typecheck, which is the library's primary usage.

Accepts the client-typings footgun that { nitro: true } prevented: a
client-side import now typechecks and fails at build time instead.
Breaking correct server code is the worse of the two.

typecheck is now a CI step. All 12 pre-existing errors are fixed."
```

---

## Part B — The typed job API (Tasks 5–12)

---

### Task 5: Dependencies and the type-test harness

Nothing in Part B can be verified without a way to assert on types. This task installs the two new dependencies and stands up `vitest --typecheck` with one deliberately trivial assertion, so that later tasks inherit a harness already known to work.

**Files:**
- Create: `vitest.types.config.ts`, `test/types/tsconfig.json`, `test/types/harness.test-d.ts`
- Modify: `package.json` (dependencies + `test:types` script), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pnpm test:types` — runs `vitest --typecheck` over `test/types/**/*.test-d.ts`.
  - `@standard-schema/spec@1.1.0` available as `import type { StandardSchemaV1 } from '@standard-schema/spec'`.
  - `zod@4.4.3` available in tests and the playground.

- [ ] **Step 1: Install the dependencies, pinned**

Run:
```bash
pnpm add -E @standard-schema/spec@1.1.0
pnpm add -DE zod@4.4.3
```

Confirm no ranges leaked in:
```bash
grep -E '"(@standard-schema/spec|zod)"' package.json
```
Expected: exact versions, no `^` or `~`.

- [ ] **Step 2: Create the type-test tsconfig**

Create `test/types/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["./**/*.ts"]
}
```

- [ ] **Step 3: Create the vitest typecheck config**

Create `vitest.types.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

/**
 * Type-level tests, run separately from `pnpm test`.
 *
 * Spec 3's deliverable is types, and a runtime suite cannot see them: every
 * one of phase 1's 175 unit tests would still pass if codegen emitted `any`
 * for every job. `include: []` is deliberate — this project contributes no
 * runtime tests, only `typecheck.include`.
 */
export default defineConfig({
  test: {
    include: [],
    typecheck: {
      enabled: true,
      only: true,
      include: ['test/types/**/*.test-d.ts'],
      tsconfig: './test/types/tsconfig.json',
    },
  },
})
```

- [ ] **Step 4: Write a harness test that proves the harness can fail**

Create `test/types/harness.test-d.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest'

/**
 * Guards the harness itself, not the library. If `pnpm test:types` ever
 * passes while `typecheck.enabled` is false or the include glob has stopped
 * matching, every other assertion in test/types/ becomes vacuous and no
 * failure appears anywhere. Deleting the @ts-expect-error below must break
 * the run.
 */
describe('type-test harness', () => {
  it('evaluates positive assertions', () => {
    expectTypeOf<string>().toEqualTypeOf<string>()
  })

  it('evaluates negative assertions', () => {
    // @ts-expect-error string is not number
    expectTypeOf<string>().toEqualTypeOf<number>()
  })
})
```

- [ ] **Step 5: Add the script**

In `package.json`, add to `scripts`:

```json
    "test:types": "vitest run --config vitest.types.config.ts",
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm test:types`
Expected: PASS, 2 assertions.

- [ ] **Step 7: Verify the harness actually fails when it should**

Delete the `// @ts-expect-error` comment line in `test/types/harness.test-d.ts`, run `pnpm test:types`, and confirm it FAILS. Then restore the comment and confirm it passes again.

This is the step that makes every later type test trustworthy. A `--typecheck` run that is silently a no-op looks identical to one that passes.

- [ ] **Step 8: Confirm `pnpm test` does not pick up the type tests**

Run: `pnpm test`
Expected: PASS, and the output must not mention `test/types/`. The unit config's `include` is `['test/unit/**/*.test.ts', 'test/*.test.ts']`, so `test/types/` is already excluded — verify rather than assume.

- [ ] **Step 9: Add the type tests to CI**

In `.github/workflows/ci.yml`, immediately after the `- run: pnpm typecheck` step added in Task 4:

```yaml
      - run: pnpm test:types
```

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.types.config.ts test/types/ .github/workflows/ci.yml
git commit -m "test: add a vitest --typecheck harness and Standard Schema dependency

Spec 3's deliverable is types, which the runtime suite cannot observe.
Includes a self-guarding harness test: if typecheck is ever disabled or
the include glob stops matching, the negative assertion stops failing and
the whole type suite would otherwise pass vacuously."
```

---

### Task 6: `JobDefinition<In, Out>`, `JobContext<Payload>` and the `defineJob` overloads

The typed core. No validation behaviour yet — that is Tasks 7 and 8.

One correction to the spec: the spec's architecture section claims `JobDefinition` "needs no phantom fields, because both parameters are recoverable from real ones". That is true for `Out` and **not** for `In`, and there is a second problem it missed — the handler the drivers call must accept `JobContext<unknown>`, because a driver has no payload type information, and `JobHandler<Out>` is not assignable to `JobHandler<unknown>` (parameter contravariance). This task therefore carries **two** handler fields: `handler` as authored, and `run` as the driver-facing wrapper.

**Files:**
- Modify: `src/runtime/server/types.ts` (whole file)
- Modify: `src/runtime/server/handlers/defineJob.ts` (whole file)
- Modify: `src/runtime/server/supervisor.ts:119` (register `run`, not `handler`)
- Test: `test/unit/defineJob.test.ts` (extend), `test/types/defineJob.test-d.ts` (create)

**Interfaces:**
- Consumes: `StandardSchemaV1` from Task 5.
- Produces:
  - `JobContext<Payload = unknown>` — `{ id, name, queue, attempt, payload: Payload }`
  - `JobHandler<Payload = unknown>` — `(ctx: JobContext<Payload>) => Promise<void> | void`
  - `BackoffOptions` — `{ type: 'fixed' | 'exponential', delay: number }`
  - `JobDefinition<In = unknown, Out = In>` — `{ name, queue, handler: JobHandler<Out>, run: JobHandler<unknown>, input?: StandardSchemaV1<In, Out>, attempts?, backoff?, __payloadTypes? }`
  - `defineJob` — two overloads as shown below.
  - `EnqueueInputOf<T>` — extracts `In`. Used by Task 12's codegen.

- [ ] **Step 1: Write the failing type test**

Create `test/types/defineJob.test-d.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'
import type { EnqueueInputOf, JobDefinition, JobPayloadOf } from '../../src/runtime/server/types'

interface SendEmailPayload {
  to: string
  subject: string
}

describe('defineJob with an explicit type argument', () => {
  it('types ctx.payload as the type argument', () => {
    defineJob<SendEmailPayload>({
      queue: 'default',
      handler: (ctx) => {
        expectTypeOf(ctx.payload).toEqualTypeOf<SendEmailPayload>()
      },
    })
  })

  it('carries the type argument into both JobDefinition parameters', () => {
    const job = defineJob<SendEmailPayload>({ handler: () => {} })
    expectTypeOf(job).toEqualTypeOf<JobDefinition<SendEmailPayload, SendEmailPayload>>()
  })

  it('is recoverable by EnqueueInputOf', () => {
    const job = defineJob<SendEmailPayload>({ handler: () => {} })
    expectTypeOf<EnqueueInputOf<typeof job>>().toEqualTypeOf<SendEmailPayload>()
  })

  it('rejects an input schema alongside an explicit type argument', () => {
    defineJob<SendEmailPayload>({
      // @ts-expect-error `input` is `never` on the type-argument overload;
      // two sources of truth for the payload type must not silently disagree.
      input: z.object({ to: z.string() }),
      handler: () => {},
    })
  })
})

describe('defineJob with an input schema', () => {
  const input = z.object({
    id: z.string().transform(Number),
    label: z.string().default('none'),
  })

  it('types ctx.payload as the schema OUTPUT', () => {
    defineJob({
      input,
      handler: (ctx) => {
        expectTypeOf(ctx.payload).toEqualTypeOf<{ id: number, label: string }>()
      },
    })
  })

  it('types the enqueue side as the schema INPUT', () => {
    const job = defineJob({ input, handler: () => {} })
    expectTypeOf<EnqueueInputOf<typeof job>>().toEqualTypeOf<{ id: string, label?: string | undefined }>()
  })

  it('keeps INPUT and OUTPUT distinct for a transforming schema', () => {
    // The assertion that catches a regression to "enqueue the transformed
    // output". If In and Out ever collapse to the same type, the producer
    // would be typed to send what only the consumer should ever see.
    //
    // Uses JobPayloadOf rather than a hand-rolled
    // `T extends JobDefinition<unknown, infer O>`: pinning a parameter instead
    // of inferring it is the fragile pattern documented on EnqueueInputOf, and
    // a conditional that silently falls through to `never` here would make
    // `not.toEqualTypeOf` pass for the wrong reason.
    const job = defineJob({ input, handler: () => {} })
    type In = EnqueueInputOf<typeof job>
    type Out = JobPayloadOf<typeof job>

    expectTypeOf<In>().not.toEqualTypeOf<Out>()
    expectTypeOf<In['id']>().toEqualTypeOf<string>()
    expectTypeOf<Out['id']>().toEqualTypeOf<number>()
  })
})

describe('defineJob with neither', () => {
  it('resolves the payload to unknown', () => {
    // Recorded deliberately: an untyped job is an accepted gap, not a bug.
    // `enqueue` on it accepts anything. Asserting it here means a future
    // change to `never` or `any` shows up as a failing test rather than as a
    // silent shift in how much safety the library provides.
    const job = defineJob({ handler: (ctx) => {
      expectTypeOf(ctx.payload).toEqualTypeOf<unknown>()
    } })
    expectTypeOf<EnqueueInputOf<typeof job>>().toEqualTypeOf<unknown>()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:types`
Expected: FAIL — `EnqueueInputOf` is not exported, and `defineJob` has no overloads, so `ctx.payload` is `unknown` everywhere.

- [ ] **Step 3: Rewrite `src/runtime/server/types.ts`**

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Role = 'web' | 'worker' | 'both'
export type SupervisorState = 'starting' | 'running' | 'draining' | 'stopped'

export interface ActiveJob {
  jobId: string
  queue: string
  name: string
  startedAt: number
}

export interface WorkerRecord {
  id: string
  hostname: string
  pid: number
  /**
   * The supervisor's actual configured role, including `web`. A `web`
   * process's record used to be reported as `both`; the health endpoint
   * reads this field directly, so misreporting it would be a lie a caller
   * could act on.
   */
  role: Role
  queues: string[]
  concurrency: Record<string, number>
  version: string
  startedAt: number
  lastHeartbeat: number
  state: 'running' | 'draining'
  active: ActiveJob[]
}

/** What a handler receives. `Payload` is the schema OUTPUT when a job declares `input`. */
export interface JobContext<Payload = unknown> {
  id: string
  name: string
  queue: string
  attempt: number
  payload: Payload
}

export type JobHandler<Payload = unknown> = (ctx: JobContext<Payload>) => Promise<void> | void

/**
 * Mirrors BullMQ's `{ type, delay }` shape deliberately, so the bullmq driver
 * passes it straight through. Any translation layer here is a place for an
 * off-by-one to hide. `jitter` is not exposed: the memory driver has no
 * conformance story for it (see the spec's deferred list).
 */
export interface BackoffOptions {
  type: 'fixed' | 'exponential'
  delay: number
}

export interface JobDefinition<In = unknown, Out = In> {
  name: string
  queue: string
  /**
   * The handler as the user wrote it, typed with the payload OUTPUT. Drivers
   * never call this directly — they call `run`.
   */
  handler: JobHandler<Out>
  /**
   * Driver-facing. Validates the decoded payload (when `input` is present)
   * and then delegates to `handler`.
   *
   * Separate from `handler` because a driver has no payload type information
   * and must be handed a `JobHandler<unknown>` — and `JobHandler<Out>` is not
   * assignable to `JobHandler<unknown>`, since parameter contravariance
   * requires `JobContext<unknown>` to be assignable to `JobContext<Out>`,
   * which is false for every concrete `Out`.
   *
   * Validation living HERE is load-bearing: it means a validation failure
   * throws inside the driver's own try/catch, so the drivers' existing
   * `retryable === false` checks classify it as permanent with no driver
   * changes at all.
   */
  run: JobHandler<unknown>
  input?: StandardSchemaV1<In, Out>
  /** TOTAL attempts including the first. Falls back to `concierge.defaults`. */
  attempts?: number
  backoff?: BackoffOptions
  /**
   * Type-only carrier, never assigned at runtime and never read.
   *
   * Without it `In` appears only inside `input`, which is optional and nests
   * the types two levels deep (`~standard.types.input`) — fragile to infer
   * through, and absent entirely from a job that declares no schema. An
   * interface whose type parameters appear in no member is structurally
   * identical for every instantiation, so `T extends JobDefinition<infer In,
   * infer Out>` would silently infer `unknown` for both and every payload
   * would go unchecked while the generated map still looked correct.
   */
  readonly __payloadTypes?: { input: In, output: Out }
}

/**
 * Extracts the ENQUEUE-side payload type (the schema input) from a job module's
 * default export. Used by the generated `ConciergeJobMap`.
 *
 * Both parameters must be inferred. `JobDefinition<infer In, unknown>` looks
 * equivalent and is not: matching it requires `JobHandler<Out>` to be
 * assignable to `JobHandler<unknown>`, which parameter contravariance makes
 * false, so the conditional would fall through to `unknown` for every job.
 */
export type EnqueueInputOf<T>
  = T extends JobDefinition<infer In, infer _Out> ? In : unknown

/** Extracts the HANDLER-side payload type (the schema output). */
export type JobPayloadOf<T>
  = T extends JobDefinition<infer _In, infer Out> ? Out : unknown
```

- [ ] **Step 4: Rewrite `src/runtime/server/handlers/defineJob.ts`**

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { BackoffOptions, JobContext, JobDefinition, JobHandler } from '../types'

export interface DefineJobOptions<Out> {
  /** Defaults to the filename, resolved at build time. */
  name?: string
  /** Must exist in concierge.worker.queues or the build fails. */
  queue?: string
  /** TOTAL attempts including the first. Falls back to `concierge.defaults`. */
  attempts?: number
  backoff?: BackoffOptions
  handler: JobHandler<Out>
}

/**
 * Overload 1 — an `input` schema supplies both payload types. Declared FIRST
 * so it wins whenever `input` is present.
 */
export function defineJob<S extends StandardSchemaV1>(
  opts: DefineJobOptions<StandardSchemaV1.InferOutput<S>> & { input: S },
): JobDefinition<StandardSchemaV1.InferInput<S>, StandardSchemaV1.InferOutput<S>>

/**
 * Overload 2 — an explicit type argument supplies the payload type.
 *
 * `input?: never` is what makes `defineJob<P>({ input: schema })` a compile
 * error instead of a silent case where the type argument and the schema
 * disagree about the payload.
 */
export function defineJob<Payload = unknown>(
  opts: DefineJobOptions<Payload> & { input?: never },
): JobDefinition<Payload, Payload>

export function defineJob(
  opts: {
    name?: string
    queue?: string
    attempts?: number
    backoff?: BackoffOptions
    input?: StandardSchemaV1
    // `never` accepts any JobHandler<X> by contravariance, which is what lets
    // one implementation signature satisfy both overloads above.
    handler: JobHandler<never>
  },
): JobDefinition<unknown, unknown> {
  if (typeof opts?.handler !== 'function') {
    throw new Error('[nuxt-concierge] defineJob requires a handler function')
  }

  const handler = opts.handler as JobHandler<unknown>

  return {
    name: opts.name ?? '',
    queue: opts.queue ?? 'default',
    handler,
    input: opts.input,
    attempts: opts.attempts,
    backoff: opts.backoff,
    // Task 7 replaces this body with one that validates first. Kept as a
    // pass-through here so this task is independently testable.
    run: (ctx: JobContext<unknown>) => handler(ctx),
  }
}
```

- [ ] **Step 5: Run the type test to verify it passes**

Run: `pnpm test:types`
Expected: PASS, all assertions in `defineJob.test-d.ts` plus the harness.

- [ ] **Step 6: Extend the runtime tests for the new fields**

Add to `test/unit/defineJob.test.ts`:

```ts
  it('exposes the user handler and a driver-facing run wrapper', async () => {
    const seen: unknown[] = []
    const job = defineJob<{ n: number }>({
      handler: (ctx) => { seen.push(ctx.payload) },
    })

    await job.run({ id: '1', name: 'j', queue: 'default', attempt: 1, payload: { n: 7 } })

    expect(seen).toEqual([{ n: 7 }])
    expect(job.handler).toBeTypeOf('function')
    expect(job.run).toBeTypeOf('function')
  })

  it('carries attempts and backoff through untouched', () => {
    const job = defineJob<void>({
      attempts: 5,
      backoff: { type: 'fixed', delay: 250 },
      handler: () => {},
    })

    expect(job.attempts).toBe(5)
    expect(job.backoff).toEqual({ type: 'fixed', delay: 250 })
  })

  it('leaves attempts and backoff undefined so config defaults can apply', () => {
    const job = defineJob<void>({ handler: () => {} })

    // Not `0`/`null`: `undefined` is what lets `entry.attempts ?? defaults.attempts`
    // fall through in useQueue. A defaulted-here value would make the module
    // default unreachable.
    expect(job.attempts).toBeUndefined()
    expect(job.backoff).toBeUndefined()
  })
```

- [ ] **Step 7: Register `run` rather than `handler` in the supervisor**

In `src/runtime/server/supervisor.ts`, line 119:

```ts
  // `run`, not `handler`: `run` is the driver-facing wrapper that validates
  // the decoded payload before delegating. Registering `handler` would skip
  // consumer-side validation entirely.
  for (const job of config.jobs) driver.registerHandler(job.queue, job.name, job.run)
```

- [ ] **Step 8: Run the full unit suite**

Run: `pnpm test`
Expected: PASS. `test/unit/supervisor.test.ts` builds `JobDefinition` fixtures by hand; each now needs a `run` field. Set it to the same function as `handler` in those fixtures.

- [ ] **Step 9: Verify typecheck is still green**

Run: `pnpm dev:prepare && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/runtime/server/types.ts src/runtime/server/handlers/defineJob.ts src/runtime/server/supervisor.ts test/unit/defineJob.test.ts test/unit/supervisor.test.ts test/types/defineJob.test-d.ts
git commit -m "feat: type defineJob payloads via a type argument or an input schema

Two overloads: an input schema supplies InferInput/InferOutput, or an
explicit type argument supplies both. 'input?: never' on the second makes
supplying both a compile error rather than a silent disagreement.

JobDefinition carries a type-only __payloadTypes field. Without it the
type parameters appear in no member for a schemaless job, so the
interface is structurally identical for every instantiation and
extraction silently yields unknown while the map still looks correct."
```

---

### Task 7: `JobPayloadInvalidError` and the validation helpers

Pure functions, no wiring. The redaction asymmetry is the substance of this task.

**Files:**
- Create: `src/runtime/server/validate.ts`
- Test: `test/unit/validate.test.ts`

**Interfaces:**
- Consumes: `StandardSchemaV1` (Task 5).
- Produces:
  - `class JobPayloadInvalidError extends Error` with `readonly retryable = false`, `readonly jobName: string`, `readonly issues: readonly StandardSchemaV1.Issue[]`
  - `validateOnEnqueue(schema, jobName, payload): Promise<void>` — throws with **full messages**; returns nothing, because the result is deliberately discarded
  - `validateOnConsume<Out>(schema, jobName, payload): Promise<Out>` — throws with **paths and counts only**; returns the validated output
  - `formatIssuePath(issue): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  JobPayloadInvalidError,
  formatIssuePath,
  validateOnConsume,
  validateOnEnqueue,
} from '../../src/runtime/server/validate'
import { isPermanentFailure } from '../../src/runtime/server/drivers/bullmq'

const schema = z.object({
  to: z.string(),
  mode: z.enum(['fast', 'slow']),
})

describe('validateOnEnqueue', () => {
  it('resolves and returns nothing for a valid payload', async () => {
    await expect(validateOnEnqueue(schema, 'j', { to: 'a@b.c', mode: 'fast' }))
      .resolves.toBeUndefined()
  })

  it('throws JobPayloadInvalidError naming the job', async () => {
    await expect(validateOnEnqueue(schema, 'send-email', { to: 1, mode: 'fast' }))
      .rejects.toThrow(JobPayloadInvalidError)
    await expect(validateOnEnqueue(schema, 'send-email', { to: 1, mode: 'fast' }))
      .rejects.toThrow(/send-email/)
  })

  it('includes full issue messages, because this error stays in the caller process', async () => {
    const error = await validateOnEnqueue(schema, 'j', { to: 'a', mode: 'sideways' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error).toBeInstanceOf(JobPayloadInvalidError)
    expect(error.message).toContain('mode')
    // Zod's enum message embeds the received value. On the PRODUCER side that
    // is fine and useful: this error returns to whoever supplied the data.
    expect(error.message).toContain('sideways')
  })

  it('exposes structured issues so a route can map them to a 400', async () => {
    const error = await validateOnEnqueue(schema, 'j', { to: 1, mode: 'fast' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error.issues.length).toBeGreaterThan(0)
    expect(error.jobName).toBe('j')
    expect(formatIssuePath(error.issues[0]!)).toBe('to')
  })

  it('awaits an async schema', async () => {
    const asyncSchema = z.object({ n: z.number() }).refine(
      async v => v.n > 0,
      { message: 'must be positive' },
    )

    await expect(validateOnEnqueue(asyncSchema, 'j', { n: -1 })).rejects.toThrow(JobPayloadInvalidError)
    await expect(validateOnEnqueue(asyncSchema, 'j', { n: 1 })).resolves.toBeUndefined()
  })
})

describe('validateOnConsume', () => {
  it('returns the validated OUTPUT, not the input', async () => {
    const transforming = z.object({ id: z.string().transform(Number) })

    await expect(validateOnConsume(transforming, 'j', { id: '42' }))
      .resolves.toEqual({ id: 42 })
  })

  it('redacts issue messages but reports the path', async () => {
    const error = await validateOnConsume(schema, 'j', { to: 'a', mode: 'sideways' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    // Both halves are required. Asserting only the exclusion would pass on an
    // empty message; asserting only the inclusion would pass on a message
    // that leaked the value alongside the path.
    expect(error.message).not.toContain('sideways')
    expect(error.message).toContain('mode')
  })

  it('reports the issue count', async () => {
    const error = await validateOnConsume(schema, 'j', { to: 1, mode: 'nope' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error.message).toContain('2 issue')
  })

  it('keeps structured issues on the error even though the message omits them', async () => {
    const error = await validateOnConsume(schema, 'j', { to: 'a', mode: 'sideways' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    // Redaction protects the SERIALISED message (BullMQ's failedReason).
    // In-process consumers can still inspect the detail.
    expect(error.issues.some(i => i.message.includes('sideways'))).toBe(true)
  })

  it('classifies as a permanent failure through the drivers existing check', async () => {
    const error = await validateOnConsume(schema, 'j', { to: 1, mode: 'fast' })
      .catch((e: unknown) => e as JobPayloadInvalidError)

    expect(error.retryable).toBe(false)
    // The whole driver integration: no bullmq/memory change is needed because
    // both already branch on `retryable === false`.
    expect(isPermanentFailure(error)).toBe(true)
  })
})

describe('formatIssuePath', () => {
  it('joins nested path segments with dots', () => {
    expect(formatIssuePath({ message: 'x', path: ['user', 'email'] })).toBe('user.email')
  })

  it('unwraps object path segments', () => {
    expect(formatIssuePath({ message: 'x', path: [{ key: 'user' }, { key: 0 }] })).toBe('user.0')
  })

  it('reports a root-level issue distinctly', () => {
    expect(formatIssuePath({ message: 'x' })).toBe('(root)')
    expect(formatIssuePath({ message: 'x', path: [] })).toBe('(root)')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/validate.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/server/validate`.

- [ ] **Step 3: Create `src/runtime/server/validate.ts`**

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * A payload that does not match its job's schema.
 *
 * `retryable = false` is the entire driver integration. `isPermanentFailure`
 * in drivers/bullmq.ts and the equivalent branch in drivers/memory.ts already
 * key off exactly this field, so a validation failure becomes a BullMQ
 * `UnrecoverableError` and skips the remaining attempt budget without either
 * driver knowing this class exists.
 *
 * Retrying is pointless by construction: a payload this build cannot accept
 * fails identically on every attempt, so retrying only burns the budget and
 * delays the dead-letter.
 */
export class JobPayloadInvalidError extends Error {
  readonly retryable = false
  readonly jobName: string
  readonly issues: readonly StandardSchemaV1.Issue[]

  constructor(message: string, jobName: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(`[nuxt-concierge] ${message}`)
    this.name = 'JobPayloadInvalidError'
    this.jobName = jobName
    this.issues = issues
  }
}

/**
 * `['user', 'email'] -> 'user.email'`. Standard Schema allows a path segment
 * to be either a raw key or an object wrapping one, so both are handled.
 */
export const formatIssuePath = (issue: StandardSchemaV1.Issue): string => {
  if (!issue.path?.length) return '(root)'

  return issue.path
    .map((segment) => {
      const key = typeof segment === 'object' && segment !== null && 'key' in segment
        ? segment.key
        : segment
      return String(key)
    })
    .join('.')
}

/**
 * Producer side. Validates and **discards the result**.
 *
 * Discarding is the point, not an oversight. Only the consumer's output is
 * ever used, so a transforming schema runs exactly once — enqueueing the
 * transformed output instead would make the consumer re-validate an
 * already-transformed value, and `z.string().transform(Number)` applied twice
 * fails on the second pass. A job correct at the call site would be
 * permanently dead in the worker.
 *
 * Messages are NOT redacted here: this error returns to the caller that just
 * supplied the data, in that caller's own process, and never reaches the
 * queue backend.
 */
export const validateOnEnqueue = async (
  schema: StandardSchemaV1,
  jobName: string,
  payload: unknown,
): Promise<void> => {
  const result = await schema['~standard'].validate(payload)
  if (!result.issues) return

  const detail = result.issues
    .map(issue => `${formatIssuePath(issue)}: ${issue.message}`)
    .join('; ')

  throw new JobPayloadInvalidError(
    `payload for job "${jobName}" failed validation — ${detail}`,
    jobName,
    result.issues,
  )
}

/**
 * Consumer side. Validates and **returns the output**, which is what the
 * handler receives. This side is authoritative: its schema is the one from
 * the build that is actually going to run the job, which is what makes
 * validating twice worthwhile across a rolling deploy.
 *
 * The message carries issue PATHS AND A COUNT ONLY, never issue messages.
 * This text becomes BullMQ's `failedReason`, which is persisted in Redis and
 * written to the log stream, and Standard Schema issue messages can embed
 * received values — Zod's enum and literal messages do exactly that
 * (`Invalid enum value. Expected 'a' | 'b', received 'c'`). Job payloads
 * routinely carry user data. Same reasoning as `describeEnvelopeShape` in
 * envelope.ts, which reports an unrecognised value's shape and never its
 * content.
 *
 * The full issues remain on the error object for in-process inspection.
 */
export const validateOnConsume = async <Out>(
  schema: StandardSchemaV1<unknown, Out>,
  jobName: string,
  payload: unknown,
): Promise<Out> => {
  const result = await schema['~standard'].validate(payload)

  if (result.issues) {
    const paths = [...new Set(result.issues.map(formatIssuePath))].sort().join(', ')

    throw new JobPayloadInvalidError(
      `payload for job "${jobName}" failed validation in the worker: `
      + `${result.issues.length} issue(s) at ${paths}. `
      + `Issue messages are omitted because this text is persisted as the job's failedReason.`,
      jobName,
      result.issues,
    )
  }

  return result.value
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/validate.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Verify the redaction assertion can actually fail**

Temporarily change `validateOnConsume`'s message to interpolate `issue.message` as well, re-run, and confirm the `does not contain 'sideways'` test FAILS. Revert.

Without this, the redaction test passes for any message that happens not to contain that word, including an empty one.

- [ ] **Step 6: Run the full unit suite and lint**

Run: `pnpm test && pnpm lint`
Expected: PASS. `vitest/no-conditional-expect` is active on `test/**`; the tests above use `.catch()` to capture the error and then assert unconditionally, which satisfies it.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/validate.ts test/unit/validate.test.ts
git commit -m "feat: add JobPayloadInvalidError and the dual-side validation helpers

Producer side validates and discards the result — only the consumer's
output is used, so a transforming schema runs exactly once and cannot
fail on a second pass over its own output.

Consumer-side messages report issue paths and counts only. That text
becomes BullMQ's failedReason, persisted in Redis and logged, and Zod's
enum/literal messages embed received values. Mirrors the reasoning in
envelope.ts's describeEnvelopeShape."
```

---

### Task 8: Wire consumer-side validation into `defineJob`

**Files:**
- Modify: `src/runtime/server/handlers/defineJob.ts` (the `run` body)
- Test: `test/unit/defineJob.test.ts` (extend)

**Interfaces:**
- Consumes: `validateOnConsume` (Task 7), `JobDefinition.run` (Task 6).
- Produces: no signature change. `run` now validates before delegating.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/defineJob.test.ts`:

```ts
import { z } from 'zod'
import { JobPayloadInvalidError } from '../../src/runtime/server/validate'

describe('defineJob consumer-side validation', () => {
  const ctx = (payload: unknown) => ({
    id: '1', name: 'j', queue: 'default', attempt: 1, payload,
  })

  it('passes the schema OUTPUT to the handler, not the raw input', async () => {
    const seen: unknown[] = []
    const job = defineJob({
      input: z.object({ id: z.string().transform(Number), label: z.string().default('none') }),
      handler: (c) => { seen.push(c.payload) },
    })

    await job.run(ctx({ id: '42' }))

    expect(seen).toEqual([{ id: 42, label: 'none' }])
  })

  it('throws a permanent JobPayloadInvalidError and never calls the handler', async () => {
    let called = false
    const job = defineJob({
      input: z.object({ n: z.number() }),
      handler: () => { called = true },
    })

    await expect(job.run(ctx({ n: 'not a number' }))).rejects.toThrow(JobPayloadInvalidError)

    // Both halves: a throw that still ran the handler would leave the side
    // effects applied and then fail the job, which is the worst outcome.
    expect(called).toBe(false)
  })

  it('leaves the payload untouched when the job declares no schema', async () => {
    const seen: unknown[] = []
    const job = defineJob<{ raw: string }>({ handler: (c) => { seen.push(c.payload) } })

    await job.run(ctx({ raw: 'as-is' }))

    expect(seen).toEqual([{ raw: 'as-is' }])
  })

  it('preserves the rest of the context across validation', async () => {
    const seen: Array<{ id: string, attempt: number, queue: string, name: string }> = []
    const job = defineJob({
      input: z.object({ n: z.number() }),
      handler: (c) => { seen.push({ id: c.id, attempt: c.attempt, queue: c.queue, name: c.name }) },
    })

    await job.run({ id: 'abc', name: 'typed', queue: 'mail', attempt: 3, payload: { n: 1 } })

    expect(seen).toEqual([{ id: 'abc', attempt: 3, queue: 'mail', name: 'typed' }])
  })

  it('awaits an async handler so a rejection propagates to the driver', async () => {
    const job = defineJob<void>({
      handler: async () => { throw new Error('handler blew up') },
    })

    // If `run` did not await, this would resolve and the driver would mark a
    // failed job complete.
    await expect(job.run(ctx(undefined))).rejects.toThrow('handler blew up')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/defineJob.test.ts`
Expected: FAIL — the transform test sees `{ id: '42' }` and the invalid-payload test does not throw, because `run` is still a pass-through.

- [ ] **Step 3: Implement validation in `run`**

In `src/runtime/server/handlers/defineJob.ts`, add the import and replace the `run` field.

```ts
import { validateOnConsume } from '../validate'
```

```ts
    /**
     * Validation lives here, inside the function the driver calls, so a
     * failure throws inside the driver's own try/catch and its existing
     * `retryable === false` branch classifies it as permanent. Validating
     * before handing the job to the driver would put the throw outside that
     * handling and lose the classification.
     */
    run: async (ctx: JobContext<unknown>) => {
      const payload = opts.input
        ? await validateOnConsume(opts.input, ctx.name, ctx.payload)
        : ctx.payload

      await handler({ ...ctx, payload })
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/defineJob.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm a bullmq-driver job maps it to `UnrecoverableError`**

Run: `pnpm vitest run test/unit/drivers/bullmq-mapping.test.ts`
Expected: PASS. If that suite has no case for a `retryable === false` error thrown from a registered handler, add one now — it is the seam that makes validation failures permanent, and nothing else covers it.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test && pnpm lint && pnpm test:types`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/handlers/defineJob.ts test/unit/defineJob.test.ts test/unit/drivers/bullmq-mapping.test.ts
git commit -m "feat: validate the payload on the consumer side inside defineJob's run wrapper

Placed inside the driver-facing wrapper so the throw lands in the
driver's own try/catch, where the existing retryable === false branch
makes it permanent — no driver change required. The handler receives the
schema output; a failure never reaches the handler at all."
```

---

### Task 9: Registry and producer-side validation in `useQueue`

`Supervisor.routes` (`Map<string, string>`) becomes a registry carrying each job's schema and retry options, because the producer now needs more than the queue name.

**Files:**
- Modify: `src/runtime/server/supervisor.ts:38` (`routes` → `registry`), `:81-84` (`getDriver`), `:121`
- Modify: `src/runtime/server/utils/useQueue.ts` (whole file)
- Test: `test/unit/useQueue.test.ts` (create), `test/unit/supervisor.test.ts` (update)

**Interfaces:**
- Consumes: `validateOnEnqueue` (Task 7), `JobDefinition` (Task 6), `JobDefaults` (Task 3).
- Produces:
  - `RegistryEntry` — `{ queue: string, input?: StandardSchemaV1, attempts?: number, backoff?: BackoffOptions }`
  - `Supervisor.registry: Map<string, RegistryEntry>` (replaces `routes`)
  - `getDriver(): { driver, registry, defaults }`
  - `useQueue().enqueue(name, payload, opts?)` — unchanged call shape, now validating.

- [ ] **Step 1: Write the failing test**

Create `test/unit/useQueue.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { createSupervisor, resetSupervisor } from '../../src/runtime/server/supervisor'
import { useQueue } from '../../src/runtime/server/utils/useQueue'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'
import { JobPayloadInvalidError } from '../../src/runtime/server/validate'
import type { SupervisorConfig } from '../../src/runtime/server/supervisor'

const baseConfig = (jobs: SupervisorConfig['jobs']): SupervisorConfig => ({
  role: 'both',
  driver: 'memory',
  connection: {},
  bullmq: { maxStalledCount: 3, stalledInterval: 30_000 },
  worker: {
    queues: { default: 1 },
    shutdownTimeout: 20_000,
    heartbeatInterval: 5_000,
    heartbeatTtl: 15_000,
  },
  defaults: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
  jobs,
  version: 'test',
  isProduction: false,
})

afterEach(async () => { await resetSupervisor() })

describe('useQueue().enqueue', () => {
  it('throws a named error for an unregistered job', async () => {
    await createSupervisor(baseConfig([]))

    await expect(useQueue().enqueue('nope', {})).rejects.toThrow(/no job named "nope"/)
  })

  it('routes to the queue from the job definition', async () => {
    const job = { ...defineJob<{ n: number }>({ handler: () => {} }), name: 'j', queue: 'default' }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('j', { n: 1 })

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({ name: 'j' }))
  })

  it('rejects an invalid payload and never reaches the driver', async () => {
    const job = {
      ...defineJob({ input: z.object({ n: z.number() }), handler: () => {} }),
      name: 'typed',
      queue: 'default',
    }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await expect(useQueue().enqueue('typed', { n: 'nope' })).rejects.toThrow(JobPayloadInvalidError)

    // Both halves. A throw that happened AFTER enqueueing would leave a job
    // in the queue that the worker is guaranteed to reject.
    expect(spy).not.toHaveBeenCalled()
  })

  it('enqueues the RAW input, not the schema output', async () => {
    const job = {
      ...defineJob({ input: z.object({ id: z.string().transform(Number) }), handler: () => {} }),
      name: 'typed',
      queue: 'default',
    }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('typed', { id: '42' })

    // The transform must happen exactly once, in the worker. Enqueueing `42`
    // here would make the consumer's z.string() reject its own output.
    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({ payload: { id: '42' } }))
  })

  it('applies the job attempts and backoff when declared', async () => {
    const job = {
      ...defineJob<void>({ attempts: 7, backoff: { type: 'fixed', delay: 50 }, handler: () => {} }),
      name: 'j',
      queue: 'default',
    }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('j', undefined)

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({
      attempts: 7,
      backoff: { type: 'fixed', delay: 50 },
    }))
  })

  it('falls back to the module defaults when the job declares neither', async () => {
    const job = { ...defineJob<void>({ handler: () => {} }), name: 'j', queue: 'default' }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('j', undefined)

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    }))
  })

  it('passes an explicit delay through', async () => {
    const job = { ...defineJob<void>({ handler: () => {} }), name: 'j', queue: 'default' }
    const supervisor = await createSupervisor(baseConfig([job]))
    const spy = vi.spyOn(supervisor.driver, 'enqueue')

    await useQueue().enqueue('j', undefined, { delay: 5000 })

    expect(spy).toHaveBeenCalledWith('default', expect.objectContaining({ delay: 5000 }))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/useQueue.test.ts`
Expected: FAIL — `SupervisorConfig` has no `defaults` accepted by `getDriver`, and `enqueue` neither validates nor passes `attempts`.

- [ ] **Step 3: Replace `routes` with `registry` in the supervisor**

In `src/runtime/server/supervisor.ts`:

Add the type and import:

```ts
import type { BackoffOptions, JobDefinition, Role, SupervisorState, WorkerRecord } from './types'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * What the producer needs to know about a job in order to enqueue it.
 *
 * Replaces the old `Map<string, string>` name -> queue map: the producer now
 * also validates (so it needs `input`) and attaches retry options at
 * `add()` time (so it needs `attempts`/`backoff`), because BullMQ takes both
 * as job options rather than worker options.
 */
export interface RegistryEntry {
  queue: string
  input?: StandardSchemaV1
  attempts?: number
  backoff?: BackoffOptions
}
```

In the `Supervisor` interface, replace `readonly routes: Map<string, string>` with:

```ts
  readonly registry: Map<string, RegistryEntry>
```

Replace `getDriver`:

```ts
export const getDriver = () => {
  if (!current) throw new Error('[nuxt-concierge] the supervisor has not started yet')
  return {
    driver: current.driver,
    registry: current.registry,
    defaults: current.config.defaults,
  }
}
```

Replace the `routes` construction at line 121:

```ts
  const registry = new Map<string, RegistryEntry>(
    config.jobs.map(job => [job.name, {
      queue: job.queue,
      input: job.input,
      attempts: job.attempts,
      backoff: job.backoff,
    }]),
  )
```

and the `registry,` entry in the returned `supervisor` object literal in place of `routes,`.

- [ ] **Step 4: Rewrite `src/runtime/server/utils/useQueue.ts`**

```ts
import { getDriver } from '../supervisor'
import { validateOnEnqueue } from '../validate'

export interface EnqueueJobOptions {
  delay?: number
}

export interface TypedQueue<Map> {
  enqueue: <K extends keyof Map>(
    name: K,
    payload: Map[K],
    opts?: EnqueueJobOptions,
  ) => Promise<{ id: string }>
}

/**
 * Enqueue from anywhere in server/.
 *
 * The public, typed signature is `TypedQueue<ConciergeJobMap>`, bound by the
 * generated ambient declaration for `#concierge` (see src/templates.ts). The
 * implementation is deliberately loose, because at runtime there is no map —
 * only the registry the supervisor built from each job's own `defineJob`.
 *
 * The queue always comes from the registry (built from each job's own
 * `defineJob` declaration), never from a caller-supplied override: an
 * override would let a typo'd queue name bypass the "no such job" check
 * entirely and go straight to the driver.
 */
export const useQueue = (): TypedQueue<Record<string, unknown>> => ({
  enqueue: async (name, payload, opts = {}) => {
    const { driver, registry, defaults } = getDriver()
    const entry = registry.get(String(name))

    if (!entry) {
      throw new Error(
        `[nuxt-concierge] no job named "${String(name)}" is registered. `
        + `Create server/jobs/${String(name)}.ts.`,
      )
    }

    // Validated BEFORE enqueueing and the result discarded. Failing here
    // turns "the job dead-letters in a worker minutes from now" into "this
    // call throws", and discarding the output is what keeps a transforming
    // schema running exactly once — in the worker, whose schema is
    // authoritative across a rolling deploy.
    if (entry.input) await validateOnEnqueue(entry.input, String(name), payload)

    return driver.enqueue(entry.queue, {
      name: String(name),
      payload,
      delay: opts.delay,
      // Resolved here rather than in the driver: BullMQ takes both as job
      // options at add() time, so the producer is the only place that can
      // attach them.
      attempts: entry.attempts ?? defaults.attempts,
      backoff: entry.backoff ?? defaults.backoff,
    })
  },
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/useQueue.test.ts`
Expected: FAIL on the `attempts`/`backoff` assertions only — `EnqueueOptions` does not carry those fields yet (Task 10). The validation, routing and raw-payload tests must PASS now.

If the routing or raw-payload tests still fail, stop and fix before continuing; only the two retry-option tests are expected to be red at this point.

- [ ] **Step 6: Update the remaining `routes` references**

Run:
```bash
grep -rn "\.routes\b\|routes:" src/ test/ --include=*.ts
```
Expected: no hits outside comments. Update `test/unit/supervisor.test.ts` and any other caller to `registry`. Also update `src/runtime/server/routes/ui-handler.ts` if it reads `routes`.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: PASS except the two known-red retry-option tests in `useQueue.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/server/supervisor.ts src/runtime/server/utils/useQueue.ts test/unit/useQueue.test.ts test/unit/supervisor.test.ts
git commit -m "feat!: validate on enqueue and replace routes with a job registry

Supervisor.routes (name -> queue) becomes a registry carrying each job's
schema and retry options: the producer now validates, and BullMQ takes
attempts/backoff as job options at add() time, so the producer is the
only place that can attach them.

enqueue serialises the RAW input and discards the validated output, so a
transforming schema runs exactly once — in the worker."
```

---

### Task 10: Retry options through the driver SPI

**Files:**
- Modify: `src/runtime/server/drivers/types.ts:10-14` (`EnqueueOptions`)
- Modify: `src/runtime/server/drivers/bullmq.ts:148-155` (`enqueue`)
- Test: `test/unit/drivers/bullmq-mapping.test.ts` (extend)

**Interfaces:**
- Consumes: `BackoffOptions` (Task 6), the resolved values from `useQueue` (Task 9).
- Produces: `EnqueueOptions` gains `attempts?: number` and `backoff?: BackoffOptions`, documented as part of the SPI contract.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/drivers/bullmq-mapping.test.ts`:

```ts
describe('bullmq enqueue retry options', () => {
  it('passes attempts and backoff to queue.add', async () => {
    const add = vi.fn().mockResolvedValue({ id: '1' })
    const driver = createBullmqDriver({ connection: { url: 'redis://localhost:6379' } })
    // Replace the lazily-created Queue with a stub. Asserting on the real
    // BullMQ call arguments is what makes this test about the mapping rather
    // than about Redis.
    vi.spyOn(Queue.prototype, 'add').mockImplementation(add)

    await driver.enqueue('default', {
      name: 'j',
      payload: { a: 1 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 250 },
    })

    expect(add).toHaveBeenCalledWith(
      'j',
      expect.anything(),
      expect.objectContaining({ attempts: 5, backoff: { type: 'exponential', delay: 250 } }),
    )
  })

  it('omits attempts entirely when not supplied rather than sending 0', async () => {
    const add = vi.fn().mockResolvedValue({ id: '1' })
    const driver = createBullmqDriver({ connection: { url: 'redis://localhost:6379' } })
    vi.spyOn(Queue.prototype, 'add').mockImplementation(add)

    await driver.enqueue('default', { name: 'j', payload: {} })

    // BullMQ's own default is attempts: 0, whose retry condition
    // (attemptsMade + 1 < attempts) is never true. Sending an explicit 0 or
    // undefined must not be confused with sending 1.
    const opts = add.mock.calls[0]![2] as Record<string, unknown>
    expect(opts.attempts).toBeUndefined()
    expect(opts.backoff).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/drivers/bullmq-mapping.test.ts`
Expected: FAIL — `attempts` is not a property of `EnqueueOptions`, and the driver does not forward it.

- [ ] **Step 3: Extend `EnqueueOptions`**

In `src/runtime/server/drivers/types.ts`:

```ts
export interface EnqueueOptions {
  name: string
  payload: unknown
  delay?: number
  /**
   * TOTAL attempts including the first, matching BullMQ's own semantics
   * (`shouldRetryJob` tests `attemptsMade + 1 < opts.attempts`, with
   * `attemptsMade` at 0 on the first failure). A driver must never translate
   * between "attempts" and "retries" — that conversion is where an
   * off-by-one hides, and `memory` and `bullmq` are required to agree
   * exactly (see test/unit/retry-conformance.test.ts).
   *
   * Undefined means "the caller did not resolve a value", not "one attempt".
   * `useQueue` always resolves it from the job or `concierge.defaults`, so a
   * driver receiving `undefined` should fall back to its own single-attempt
   * behaviour rather than inventing a default.
   *
   * `sync` ignores this field: it executes inline so errors propagate to the
   * `enqueue` caller, and retrying would swallow exactly what it exists to
   * expose.
   */
  attempts?: number
  /**
   * Delay for the k-th retry is `Math.round(2 ** (k - 1) * delay)` for
   * `exponential` and `delay` for `fixed`, matching BullMQ's built-in
   * strategies.
   */
  backoff?: BackoffOptions
}
```

and add the import:

```ts
import type { ActiveJob, BackoffOptions, JobHandler, WorkerRecord } from '../types'
```

- [ ] **Step 4: Forward them in the bullmq driver**

In `src/runtime/server/drivers/bullmq.ts`, replace the `enqueue` implementation:

```ts
    enqueue: async (queue, job) => {
      const added = await queueOf(queue).add(job.name, encodePayload(job.payload), {
        delay: job.delay,
        // Straight through, no arithmetic: EnqueueOptions.attempts already
        // means what BullMQ's attempts means. Before this, nothing passed
        // attempts at all, BullMQ defaulted to 0, and `attemptsMade + 1 < 0`
        // is never true — so a failing job was never retried in production
        // while the memory driver retried it three times.
        attempts: job.attempts,
        backoff: job.backoff,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      })
      return { id: String(added.id) }
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/drivers/bullmq-mapping.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the previously-red useQueue tests now pass**

Run: `pnpm vitest run test/unit/useQueue.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck && pnpm test:types && pnpm lint`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/server/drivers/types.ts src/runtime/server/drivers/bullmq.ts test/unit/drivers/bullmq-mapping.test.ts
git commit -m "feat: carry attempts and backoff through the driver SPI

The bullmq driver never passed attempts, so BullMQ's default of 0 applied
and 'attemptsMade + 1 < 0' meant a failing job was never retried in
production — while the memory driver retried it three times. Documents
attempts as TOTAL attempts in the SPI contract so the two drivers cannot
drift on the definition again."
```

---

### Task 11: Memory-driver retry conformance

The memory driver's `MAX_ATTEMPTS = 3` is hardcoded and it retries immediately with no backoff. This task makes it honour the job's resolved values and match BullMQ's timing, verified by one table run against both drivers.

**Files:**
- Modify: `src/runtime/server/drivers/memory.ts:9` (delete `MAX_ATTEMPTS`), `:12-19` (`QueuedJob`), `:55-66` (`enqueue`), `:91-114` (retry decision)
- Create: `test/unit/retry-conformance.test.ts`

**Interfaces:**
- Consumes: `EnqueueOptions.attempts`/`backoff` (Task 10).
- Produces: `backoffDelay(backoff, retryIndex): number` exported from `src/runtime/server/drivers/memory.ts` — pure, so the formula is unit-testable without a scheduler.

- [ ] **Step 1: Establish BullMQ's actual backoff index against real Redis**

This must be observed, not read. `attemptsMade` is mutated across several call sites and a Lua script; if the index is off by one, the memory driver copies the error and the two drivers drift on timing — the exact failure this task exists to prevent.

Create a scratch script `/tmp/backoff-probe.mjs`:

```js
import { Queue, Worker } from 'bullmq'

const connection = { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' }
const q = new Queue('probe', { connection })
await q.obliterate({ force: true }).catch(() => {})

const stamps = []
const worker = new Worker('probe', async () => {
  stamps.push(Date.now())
  throw new Error('always fails')
}, { connection })

await q.add('j', {}, { attempts: 4, backoff: { type: 'exponential', delay: 200 } })

await new Promise(resolve => worker.on('failed', (job) => {
  if (job.attemptsMade >= 4) resolve()
}))

for (let i = 1; i < stamps.length; i++) {
  console.log(`gap before retry ${i}: ${stamps[i] - stamps[i - 1]}ms`)
}
await worker.close()
await q.close()
process.exit(0)
```

Run: `REDIS_URL=redis://127.0.0.1:6379 node /tmp/backoff-probe.mjs`

Record the three gaps. The reading of `backoffs.js` predicts approximately `200, 400, 800` — i.e. retry k waits `2 ** (k - 1) * delay`. **If the observed gaps are `400, 800, 1600` instead, the index is `k + 1` and every formula below must use `2 ** k`.** Write whichever you observed into the comment in Step 4 and into the table in Step 6.

- [ ] **Step 2: Write the failing conformance test**

Create `test/unit/retry-conformance.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { backoffDelay, createMemoryDriver } from '../../src/runtime/server/drivers/memory'
import type { ConciergeDriver } from '../../src/runtime/server/drivers/types'

/**
 * One table, run against every driver that claims to retry.
 *
 * Two independent test files is how depth() drifted between the drivers: the
 * contract was undocumented and each file encoded its own author's reading.
 * The `sync` driver is deliberately absent — it executes inline so errors
 * propagate to the enqueue caller, and retrying would swallow exactly what it
 * exists to expose.
 */
const RETRYING_DRIVERS: Array<[string, () => ConciergeDriver]> = [
  ['memory', () => createMemoryDriver()],
]

describe('backoffDelay', () => {
  it('returns the fixed delay unchanged for every retry index', () => {
    expect(backoffDelay({ type: 'fixed', delay: 250 }, 1)).toBe(250)
    expect(backoffDelay({ type: 'fixed', delay: 250 }, 4)).toBe(250)
  })

  it('doubles per retry for exponential, starting at delay', () => {
    // Matches the observed BullMQ gaps from Step 1. If Step 1 observed
    // 400/800/1600 instead, these become 2000/4000/8000.
    expect(backoffDelay({ type: 'exponential', delay: 1000 }, 1)).toBe(1000)
    expect(backoffDelay({ type: 'exponential', delay: 1000 }, 2)).toBe(2000)
    expect(backoffDelay({ type: 'exponential', delay: 1000 }, 3)).toBe(4000)
  })

  it('returns 0 when no backoff is configured', () => {
    expect(backoffDelay(undefined, 1)).toBe(0)
  })
})

describe.each(RETRYING_DRIVERS)('%s driver retry contract', (_name, make) => {
  let driver: ConciergeDriver

  beforeEach(async () => {
    driver = make()
    await driver.init()
  })

  afterEach(async () => { await driver.close(true) })

  const runUntilSettled = async (attemptsSeen: () => number, expected: number) => {
    const deadline = Date.now() + 5000
    while (attemptsSeen() < expected && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
    }
  }

  it('runs a succeeding job exactly once', async () => {
    let runs = 0
    driver.registerHandler('default', 'ok', () => { runs++ })
    const consumer = driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'ok', payload: {}, attempts: 3 })
    await runUntilSettled(() => runs, 1)
    await new Promise(r => setTimeout(r, 100))

    expect(runs).toBe(1)
    await consumer.close(true)
  })

  it('retries a failing job up to attempts and then stops', async () => {
    let runs = 0
    driver.registerHandler('default', 'bad', () => { runs++; throw new Error('nope') })
    const consumer = driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'bad', payload: {}, attempts: 3 })
    await runUntilSettled(() => runs, 3)
    await new Promise(r => setTimeout(r, 150))

    // Exactly 3: fewer means attempts was not honoured, more means the
    // ceiling is not enforced. Asserting >= 3 would pass on an infinite loop.
    expect(runs).toBe(3)
    await consumer.close(true)
  })

  it('succeeds on the second attempt without consuming the third', async () => {
    let runs = 0
    driver.registerHandler('default', 'flaky', () => {
      runs++
      if (runs === 1) throw new Error('first only')
    })
    const consumer = driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'flaky', payload: {}, attempts: 3 })
    await runUntilSettled(() => runs, 2)
    await new Promise(r => setTimeout(r, 150))

    expect(runs).toBe(2)
    await consumer.close(true)
  })

  it('never retries when attempts is 1', async () => {
    let runs = 0
    driver.registerHandler('default', 'once', () => { runs++; throw new Error('nope') })
    const consumer = driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'once', payload: {}, attempts: 1 })
    await new Promise(r => setTimeout(r, 200))

    expect(runs).toBe(1)
    await consumer.close(true)
  })

  it('stops immediately on a permanent failure, without consuming remaining attempts', async () => {
    let runs = 0
    driver.registerHandler('default', 'permanent', () => {
      runs++
      throw Object.assign(new Error('bad payload'), { retryable: false })
    })
    const consumer = driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', { name: 'permanent', payload: {}, attempts: 5 })
    await new Promise(r => setTimeout(r, 250))

    expect(runs).toBe(1)
    await consumer.close(true)
  })

  it('waits the backoff delay before retrying', async () => {
    const stamps: number[] = []
    driver.registerHandler('default', 'slow-retry', () => {
      stamps.push(Date.now())
      throw new Error('nope')
    })
    const consumer = driver.consume('default', { concurrency: 1 })

    await driver.enqueue('default', {
      name: 'slow-retry',
      payload: {},
      attempts: 2,
      backoff: { type: 'fixed', delay: 300 },
    })
    await runUntilSettled(() => stamps.length, 2)

    expect(stamps).toHaveLength(2)
    // Bounded on both sides. A lower bound alone passes on a driver that
    // waits forever; an upper bound alone passes on one that never waits.
    const gap = stamps[1]! - stamps[0]!
    expect(gap).toBeGreaterThanOrEqual(280)
    expect(gap).toBeLessThan(1200)

    await consumer.close(true)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run test/unit/retry-conformance.test.ts`
Expected: FAIL — `backoffDelay` is not exported, and the memory driver ignores `attempts` (it uses its own `MAX_ATTEMPTS = 3`) and applies no delay.

- [ ] **Step 4: Implement the retry contract in the memory driver**

In `src/runtime/server/drivers/memory.ts`:

Delete `const MAX_ATTEMPTS = 3` and add:

```ts
/**
 * Mirrors BullMQ's built-in strategies exactly
 * (`bullmq/dist/esm/classes/backoffs.js`): `fixed` returns the delay
 * unchanged, `exponential` returns `Math.round(2 ** (k - 1) * delay)` for the
 * k-th retry, so the first retry waits exactly `delay`.
 *
 * The index was OBSERVED against real Redis, not read off the source —
 * `attemptsMade` is mutated across several call sites and a Lua script. See
 * the probe in the spec 3 plan, Task 11 Step 1.
 *
 * Exported so the formula is testable without a scheduler, and so the shared
 * conformance table can assert on it directly.
 */
export const backoffDelay = (
  backoff: BackoffOptions | undefined,
  retryIndex: number,
): number => {
  if (!backoff) return 0
  if (backoff.type === 'fixed') return backoff.delay
  return Math.round(2 ** (retryIndex - 1) * backoff.delay)
}
```

Add `attempts` and `backoff` to `QueuedJob`:

```ts
interface QueuedJob {
  id: string
  name: string
  queue: string
  envelope: { v: number, payload: string }
  attempt: number
  runAt: number
  /** TOTAL attempts including the first. `undefined` means one attempt. */
  attempts?: number
  backoff?: BackoffOptions
}
```

Carry them through `enqueue`:

```ts
    enqueue: async (queue, job) => {
      const id = `mem-${++counter}`
      queueOf(queue).push({
        id,
        name: job.name,
        queue,
        envelope: encodePayload(job.payload),
        attempt: 0,
        runAt: Date.now() + (job.delay ?? 0),
        attempts: job.attempts,
        backoff: job.backoff,
      })
      return { id }
    },
```

Replace the retry decision in the `catch` block:

```ts
        catch (error) {
          // `run` is invoked as `void run(job)` (fire-and-forget), so a
          // TypeError thrown HERE (reading `.retryable` off a thrown `null`/
          // `undefined`/primitive) becomes an unhandled rejection that can
          // take the whole process down, with the job neither retried nor
          // logged. Guard the shape before reading the property.
          const permanent = typeof error === 'object' && error !== null
            && (error as { retryable?: boolean }).retryable === false

          // `attempts` is TOTAL attempts including the first, matching
          // BullMQ. `job.attempt` was already incremented before `run`, so it
          // is the number of attempts MADE. An absent `attempts` means one
          // attempt — never a hardcoded ceiling: this used to be
          // MAX_ATTEMPTS = 3 while bullmq passed nothing and therefore never
          // retried at all, so a flaky job passed here and dead-lettered on
          // first failure in production.
          const totalAttempts = job.attempts ?? 1
          const willRetry = !permanent && job.attempt < totalAttempts

          if (willRetry) {
            logger.warn(
              `[${queue}] job "${job.name}" (${job.id}) failed on attempt ${job.attempt}, retrying`,
              error,
            )
            queueOf(queue).push({
              ...job,
              runAt: Date.now() + backoffDelay(job.backoff, job.attempt),
            })
          }
          else {
            const reason = permanent
              ? 'failed permanently and will not be retried'
              : `failed after ${job.attempt} attempt(s)`
            logger.error(`[${queue}] job "${job.name}" (${job.id}) ${reason}`, error)
          }
        }
```

Add the import:

```ts
import type { ActiveJob, BackoffOptions, JobHandler, WorkerRecord } from '../types'
```

- [ ] **Step 5: Run the conformance test to verify it passes**

Run: `pnpm vitest run test/unit/retry-conformance.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the bullmq driver to the same table**

Extend `RETRYING_DRIVERS` in `test/unit/retry-conformance.test.ts`, guarded so the suite still runs without Redis (`pnpm test` must stay Redis-free — that is an established convention so contributors without Redis can run it):

```ts
const RETRYING_DRIVERS: Array<[string, () => ConciergeDriver]> = [
  ['memory', () => createMemoryDriver()],
  // Only when a real Redis is available. `pnpm test` is deliberately
  // Redis-free; CI supplies REDIS_URL, and `pnpm test:lifecycle` always has
  // it. Skipping silently is acceptable here ONLY because the same table also
  // runs against `memory` unconditionally, so a broken table cannot pass
  // everywhere by being skipped everywhere.
  ...(process.env.REDIS_URL
    ? [['bullmq', () => createBullmqDriver({
        connection: { url: process.env.REDIS_URL },
        bullmq: { maxStalledCount: 3, stalledInterval: 1000 },
      })] as [string, () => ConciergeDriver]]
    : []),
]
```

Add the import and a per-driver queue name so parallel runs cannot collide on Redis keys — replace the literal `'default'` queue in each test with a unique name derived from the test title, or call `driver.close(true)` plus `obliterate` in `afterEach` for the bullmq case.

- [ ] **Step 7: Verify both drivers pass the same table**

Run:
```bash
pnpm vitest run test/unit/retry-conformance.test.ts                              # memory only
REDIS_URL=redis://127.0.0.1:6379 pnpm vitest run test/unit/retry-conformance.test.ts   # both
```
Expected: PASS in both modes, and the second run must report roughly twice as many tests as the first. If the counts match, the bullmq entry is being skipped and the conformance claim is hollow — fix the guard before continuing.

- [ ] **Step 8: Verify the timing assertion is falsifiable**

Temporarily change `backoffDelay` to always `return 0`, re-run, and confirm the "waits the backoff delay" case FAILS for **both** drivers. Revert.

- [ ] **Step 9: Run the whole gate**

Run: `pnpm test && pnpm lint && pnpm typecheck && pnpm test:types`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/runtime/server/drivers/memory.ts test/unit/retry-conformance.test.ts
git commit -m "feat: make the memory driver honour attempts and backoff

Deletes the hardcoded MAX_ATTEMPTS = 3 and the immediate-retry behaviour.
memory now matches bullmq on both attempt count and delay, verified by
one shared conformance table run against both drivers rather than two
independent files — which is how depth() drifted.

The exponential index was observed against real Redis, not read off
backoffs.js: attemptsMade is mutated across several call sites and a Lua
script."
```

---

### Task 12: Generate `ConciergeJobMap` and type `enqueue`

The payoff. Everything before this made `enqueue` *typeable*; this makes it typed.

The mechanism is ambient module merging. Two `declare module "#concierge"` blocks merge, so the generated job map can add members to an interface declared in the existing template — no package subpath export and no global namespace pollution.

**Files:**
- Modify: `src/templates.ts` (`createTemplateType`), `src/module.ts` (pass the scan to it)
- Create: `test/types/enqueue.test-d.ts`
- Test: `test/unit/templates.test.ts` (create)

**Interfaces:**
- Consumes: `scanJobs()` output (`src/scan.ts`), `EnqueueInputOf` and `JobDefinition` (Task 6), `TypedQueue` (Task 9), the both-graphs emission from Task 4.
- Produces:
  - `buildJobMapDeclaration(jobs: ScannedJob[]): string` — pure, exported from `src/templates.ts` so it is unit-testable without a Nuxt instance.
  - Ambient `interface ConciergeJobMap` inside `declare module "#concierge"`, one key per scanned job.
  - `useQueue()` typed as `TypedQueue<ConciergeJobMap>` for consumers.

- [ ] **Step 1: Write the failing unit test for the generator**

Create `test/unit/templates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildJobMapDeclaration } from '../../src/templates'

describe('buildJobMapDeclaration', () => {
  it('emits one literal key per scanned job', () => {
    const out = buildJobMapDeclaration([
      { file: '/abs/server/jobs/send-email.ts', name: 'send-email' },
      { file: '/abs/server/jobs/mail/send.ts', name: 'mail/send' },
    ])

    expect(out).toContain(`"send-email": typeof import("/abs/server/jobs/send-email")["default"]`)
    expect(out).toContain(`"mail/send": typeof import("/abs/server/jobs/mail/send")["default"]`)
  })

  it('strips the .ts extension from the import specifier', () => {
    const out = buildJobMapDeclaration([{ file: '/abs/server/jobs/j.ts', name: 'j' }])

    expect(out).not.toContain('j.ts')
    expect(out).toContain('/abs/server/jobs/j"')
  })

  it('augments #concierge so the declaration merges with the useQueue one', () => {
    const out = buildJobMapDeclaration([{ file: '/abs/j.ts', name: 'j' }])

    // Merging is the whole mechanism: a different module specifier here would
    // declare a second, unrelated ConciergeJobMap that useQueue never sees,
    // and every enqueue would silently fall back to the empty interface.
    expect(out).toContain('declare module "#concierge"')
    expect(out).toContain('interface ConciergeJobMap')
  })

  it('emits an empty interface body when there are no jobs', () => {
    const out = buildJobMapDeclaration([])

    expect(out).toContain('interface ConciergeJobMap')
    expect(out).not.toContain('typeof import')
  })

  it('escapes nothing unexpected into the key', () => {
    // Names come from file paths, so a quote cannot appear — but if scan.ts
    // ever changes, a broken literal must fail here rather than emit a
    // .d.ts that does not parse.
    const out = buildJobMapDeclaration([{ file: '/abs/a-b_c.1.ts', name: 'a-b_c.1' }])

    expect(out).toContain(`"a-b_c.1":`)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/unit/templates.test.ts`
Expected: FAIL — `buildJobMapDeclaration` is not exported.

- [ ] **Step 3: Implement the generator and wire it into the template**

In `src/templates.ts`, add the import of the scan type and the generator:

```ts
import type { ScannedJob } from "./scan";
```

```ts
/**
 * Emits the generated half of the `#concierge` module declaration: one
 * `ConciergeJobMap` entry per scanned job, keyed by the job's name and valued
 * by its module's default export type.
 *
 * Two things make this work and both are load-bearing:
 *
 * 1. It augments `#concierge`, the SAME ambient module the `useQueue`
 *    declaration lives in. Ambient `declare module` blocks with matching
 *    specifiers MERGE, so `ConciergeJobMap` here and the empty one declared
 *    alongside `useQueue` become a single interface. Augmenting any other
 *    specifier — a package subpath, a global — would create a second,
 *    unrelated interface that `useQueue` never sees, and every enqueue would
 *    silently fall back to the empty one with no error anywhere.
 *
 * 2. `typeof import(...)` is type-only, so nothing here enters any bundle.
 *    Job modules are still imported eagerly by the runtime plugin; that is a
 *    separate concern and deliberately unchanged (see the spec's
 *    "Why there is no AST extraction").
 *
 * Names and paths come straight from `scanJobs()` so there is exactly one
 * source of truth for what a job is called.
 */
export const buildJobMapDeclaration = (jobs: ScannedJob[]): string => {
  const entries = jobs
    .map(
      (job) =>
        `      ${JSON.stringify(job.name)}: typeof import(${JSON.stringify(
          job.file.replace(/\.(ts|js|mjs)$/, "")
        )})["default"];`
    )
    .join("\n");

  return `
  declare module "#concierge" {
    interface ConciergeJobMap {
${entries}
    }
  }
  `;
};
```

Then change `createTemplateType` to accept the scan and emit the map into both graphs. Replace its signature and the `types/concierge.d.ts` block from Task 4 with:

```ts
export const createTemplateType = (jobs: ScannedJob[] = []) => {
  const { resolve } = createResolver(import.meta.url);
  const nuxt = useNuxt();

  nuxt.hook("nitro:config", (nitroConfig) => {
    if (!nitroConfig.alias) return;

    nitroConfig.alias["#concierge"] = resolve(
      "./runtime/server/utils/useQueue"
    );

    nitroConfig.alias["#concierge-handlers"] = resolve(
      "./runtime/server/handlers"
    );

    nitroConfig.alias["#concierge/role"] = resolve("./runtime/server/role");
    nitroConfig.alias["#concierge/supervisor"] = resolve(
      "./runtime/server/supervisor"
    );
    nitroConfig.alias["#concierge/shutdown"] = resolve(
      "./runtime/server/shutdown"
    );
    nitroConfig.alias["#concierge/guardrails"] = resolve(
      "./runtime/server/guardrails"
    );
  });

  addTypeTemplate(
    {
      filename: "types/concierge-handlers.d.ts",
      write: true,
      getContents() {
        return `
  declare module "#concierge-handlers" {
   const defineJob: typeof import("${resolve(
     "./runtime/server/handlers/defineJob"
   )}").defineJob;
  }
      `;
      },
    },
    { nitro: true }
  );

  // `useQueue` is declared as TypedQueue<ConciergeJobMap> rather than as
  // `typeof import(...).useQueue`: the runtime signature is deliberately
  // loose (there is no map at runtime, only the supervisor's registry), and
  // the generic surface lives in the source file so the two cannot drift.
  //
  // `ConciergeJobMap` is declared EMPTY here and filled by
  // buildJobMapDeclaration's separate template. Both are ambient
  // `declare module "#concierge"` blocks, so they merge.
  const conciergeModule = `
  declare module "#concierge" {
    interface ConciergeJobMap {}

    const useQueue: () => import("${resolve(
      "./runtime/server/utils/useQueue"
    )}").TypedQueue<ConciergeJobMap>;
  }
  `;

  const jobMap = buildJobMapDeclaration(jobs);

  // Both declarations go into BOTH graphs. See the Task 4 note: nitro's
  // generated `nitro-routes.d.ts` references every server route handler to
  // type $fetch, which pulls those handlers into the APP program — so a route
  // that imports `#concierge` fails with TS2307 there unless the app graph
  // has the declaration too.
  for (const [suffix, options] of [
    ["", { nitro: true as const }],
    ["-app", undefined],
  ] as const) {
    addTypeTemplate(
      {
        filename: `types/concierge${suffix}.d.ts`,
        write: true,
        getContents: () => conciergeModule,
      },
      options
    );

    addTypeTemplate(
      {
        filename: `types/concierge-jobs${suffix}.d.ts`,
        write: true,
        getContents: () => jobMap,
      },
      options
    );
  }
};
```

- [ ] **Step 4: Pass the scan into the template from the module**

In `src/module.ts`, line 66:

```ts
    createTemplateType(jobs);
```

`jobs` is already in scope from `const jobs = await scanJobs()` on line 60.

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `pnpm vitest run test/unit/templates.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing type test for `enqueue`**

Create `test/types/enqueue.test-d.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'
import type { TypedQueue } from '../../src/runtime/server/utils/useQueue'
import type { EnqueueInputOf } from '../../src/runtime/server/types'

/**
 * Stands in for the generated ConciergeJobMap. The real one is an ambient
 * declaration produced at build time, which a type test cannot import — so
 * this asserts the SHAPE the generator targets: keys are job names, values
 * are job-module default export types, and TypedQueue reads through
 * EnqueueInputOf. `test/unit/templates.test.ts` covers the generator's
 * output text; together they cover both halves.
 */
interface SendEmailPayload {
  to: string
  subject: string
}

const sendEmail = defineJob<SendEmailPayload>({ queue: 'default', handler: () => {} })
const archive = defineJob({
  input: z.object({ id: z.string().transform(Number) }),
  handler: () => {},
})

interface TestJobMap {
  'send-email': EnqueueInputOf<typeof sendEmail>
  'mail/archive': EnqueueInputOf<typeof archive>
}

declare const queue: TypedQueue<TestJobMap>

describe('typed enqueue', () => {
  it('accepts a correct payload', () => {
    expectTypeOf(queue.enqueue).toBeCallableWith('send-email', { to: 'a@b.c', subject: 'hi' })
  })

  it('accepts an options object', () => {
    expectTypeOf(queue.enqueue).toBeCallableWith(
      'send-email',
      { to: 'a@b.c', subject: 'hi' },
      { delay: 5000 },
    )
  })

  it('rejects an unknown job name', () => {
    // @ts-expect-error 'send-emial' is not a key of the job map
    queue.enqueue('send-emial', { to: 'a@b.c', subject: 'hi' })
  })

  it('rejects a payload with a wrong field type', () => {
    // @ts-expect-error `to` is a string
    queue.enqueue('send-email', { to: 1, subject: 'hi' })
  })

  it('rejects a payload missing a required field', () => {
    // @ts-expect-error `subject` is required
    queue.enqueue('send-email', { to: 'a@b.c' })
  })

  it('types a schema-backed job by its INPUT, not its output', () => {
    expectTypeOf(queue.enqueue).toBeCallableWith('mail/archive', { id: '42' })
  })

  it('rejects the schema OUTPUT on the enqueue side', () => {
    // The transform runs in the worker. Accepting a number here would mean
    // the producer sent something the consumer's z.string() must reject.
    // @ts-expect-error `id` is a string on the enqueue side
    queue.enqueue('mail/archive', { id: 42 })
  })

  it('narrows the name parameter to a literal union', () => {
    expectTypeOf<Parameters<typeof queue.enqueue>[0]>()
      .toEqualTypeOf<'send-email' | 'mail/archive'>()
  })
})
```

- [ ] **Step 7: Run the type test to verify it passes**

Run: `pnpm test:types`
Expected: PASS.

If the `@ts-expect-error` on "rejects an unknown job name" reports *unused*, `keyof TestJobMap` is not constraining the parameter — fix `TypedQueue` in `src/runtime/server/utils/useQueue.ts` rather than deleting the assertion.

- [ ] **Step 8: Verify the real generated map types the real playground call site**

Add a deliberate error to `playground/server/api/enqueue.post.ts` — change `enqueue('slow', { seq: offset + i, durationMs })` to `enqueue('slow', { seq: 'not a number', durationMs })` — then run:

```bash
pnpm dev:prepare
pnpm typecheck 2>&1 | grep "enqueue.post"
```
Expected: a type error on that line.

This is the only step that exercises the actual generated declaration end to end; every other type test uses a stand-in map. Revert the deliberate error afterwards and confirm `pnpm typecheck` returns to 0 errors.

Note: `slow` has no payload type yet, so this will only fail once Task 14 types it. If it does **not** fail here, complete Task 14 and then return to this step — do not mark the task done on the strength of the stand-in tests alone.

- [ ] **Step 9: Verify an unknown job name is a compile error in the playground**

Change the same call to `enqueue('slwo', …)`, run `pnpm typecheck`, confirm an error naming the map, then revert.

- [ ] **Step 10: Run the whole gate**

Run: `pnpm dev:prepare && pnpm lint && pnpm typecheck && pnpm test && pnpm test:types`
Expected: all PASS, 0 typecheck errors.

- [ ] **Step 11: Commit**

```bash
git add src/templates.ts src/module.ts test/unit/templates.test.ts test/types/enqueue.test-d.ts
git commit -m "feat: generate ConciergeJobMap and make enqueue generic over it

Augments the same ambient '#concierge' module the useQueue declaration
lives in, so the two ConciergeJobMap declarations merge. Augmenting any
other specifier would create a second, unrelated interface that useQueue
never sees, and every enqueue would silently fall back to the empty one.

typeof import(...) is type-only, so nothing enters any bundle."
```

---

## Part C — End-to-end verification and documentation (Tasks 13–14)

---

### Task 13: Lifecycle scenarios against real Redis

**Files:**
- Create: `test/lifecycle/retry.test.ts`
- Create: `playground/server/jobs/failing.ts`
- Modify: `test/lifecycle/harness.ts` if it lacks a helper these need

**Interfaces:**
- Consumes: the harness's existing spawn/signal/poll helpers, `playground/server/api/enqueue.post.ts`.
- Produces: two lifecycle scenarios. No new exports.

- [ ] **Step 1: Read the harness to learn its helpers**

Run: `sed -n '1,80p' test/lifecycle/harness.ts`

Note the exported helpers for spawning a built playground process, polling `/_concierge/health`, and reading the append-only `CONCIERGE_TEST_LOG`. Reuse them; do not add fixed sleeps — readiness comes from polling the health endpoint, never from `setTimeout`.

- [ ] **Step 2: Create a job that fails a controlled number of times**

Create `playground/server/jobs/failing.ts`:

```ts
import { appendFileSync } from 'node:fs'
import { defineJob } from '#concierge-handlers'

export interface FailingPayload {
  seq: number
  /** Fail on every attempt at or below this number. `0` never fails. */
  failUntilAttempt: number
}

export default defineJob<FailingPayload>({
  queue: 'default',
  attempts: 3,
  // Short and fixed so the scenario does not spend 1s+2s waiting on the
  // default exponential policy.
  backoff: { type: 'fixed', delay: 100 },
  handler: async (ctx) => {
    const { seq, failUntilAttempt } = ctx.payload

    if (process.env.CONCIERGE_TEST_LOG) {
      appendFileSync(
        process.env.CONCIERGE_TEST_LOG,
        `${JSON.stringify({ jobId: seq, attempt: ctx.attempt, pid: process.pid, id: ctx.id })}\n`,
      )
    }

    if (ctx.attempt <= failUntilAttempt) {
      throw new Error(`deliberate failure on attempt ${ctx.attempt}`)
    }
  },
})
```

- [ ] **Step 3: Add a job with a schema, to exercise dead-lettering**

Create `playground/server/jobs/typed.ts`:

```ts
import { appendFileSync } from 'node:fs'
import { z } from 'zod'
import { defineJob } from '#concierge-handlers'

export default defineJob({
  queue: 'default',
  attempts: 3,
  input: z.object({
    seq: z.number(),
    // Transforms, so the enqueue side is a string and the handler side a
    // number — which is what makes the transform-once property observable
    // end to end rather than only in unit tests.
    id: z.string().transform(Number),
  }),
  handler: async (ctx) => {
    if (process.env.CONCIERGE_TEST_LOG) {
      appendFileSync(
        process.env.CONCIERGE_TEST_LOG,
        `${JSON.stringify({
          jobId: ctx.payload.seq,
          attempt: ctx.attempt,
          // Recorded so the test can assert the handler saw a NUMBER.
          idType: typeof ctx.payload.id,
          idValue: ctx.payload.id,
        })}\n`,
      )
    }
  },
})
```

- [ ] **Step 4: Let the playground enqueue arbitrary named jobs**

Modify `playground/server/api/enqueue.post.ts` so the harness can target any job, keeping the existing `MAX_COUNT` clamp and `offset` behaviour:

```ts
import { defineEventHandler, readBody } from 'h3'
import { useQueue } from '#concierge'

const MAX_COUNT = 100

export default defineEventHandler(async (event) => {
  const {
    job = 'slow',
    count: rawCount = 1,
    offset = 0,
    payload = {},
  } = await readBody(event)

  const count = Number.isFinite(rawCount) ? Math.min(Math.max(rawCount, 0), MAX_COUNT) : 1
  const { enqueue } = useQueue()

  const ids: string[] = []
  const errors: string[] = []

  for (let i = 0; i < count; i++) {
    try {
      // Cast: this fixture route enqueues a NAME chosen at runtime, which is
      // exactly the case the generated literal union exists to prevent. It is
      // deliberate here and confined to the harness's own entry point — the
      // typed path is asserted in test/types/enqueue.test-d.ts and by the
      // playground's own typed call sites.
      const { id } = await enqueue(
        job as 'slow',
        { seq: offset + i, ...payload } as never,
      )
      ids.push(id)
    }
    catch (error) {
      // Surfaced rather than thrown so a producer-side validation rejection
      // is observable to the test as data instead of a 500.
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  return { ids, errors }
})
```

- [ ] **Step 5: Write the failing lifecycle test**

Create `test/lifecycle/retry.test.ts`, adapting the import list and helper names to whatever `test/lifecycle/harness.ts` actually exports:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { startProcess, stopProcess, enqueueJobs, readLog, waitForLog } from './harness'

describe('retry across a real drain', () => {
  afterEach(async () => { await stopProcess() })

  it('retries a job that fails once and completes it', async () => {
    const proc = await startProcess({ role: 'both', driver: 'bullmq' })

    await enqueueJobs(proc, { job: 'failing', count: 1, payload: { failUntilAttempt: 1 } })
    await waitForLog(entry => entry.attempt === 2)

    const entries = readLog()
    const attempts = entries.filter(e => e.jobId === 0).map(e => e.attempt).sort()

    // Exactly [1, 2]: attempt 1 failed, attempt 2 ran. A bare
    // `length >= 2` would pass on a driver retrying forever, and asserting
    // only `includes(2)` would pass on one that skipped attempt 1.
    expect(attempts).toEqual([1, 2])
  })

  it('stops after the configured attempts and does not retry forever', async () => {
    const proc = await startProcess({ role: 'both', driver: 'bullmq' })

    await enqueueJobs(proc, { job: 'failing', count: 1, payload: { failUntilAttempt: 99 } })
    await waitForLog(entry => entry.attempt === 3)
    // Past the third attempt's backoff, so a fourth would have landed.
    await new Promise(r => setTimeout(r, 800))

    const attempts = readLog().filter(e => e.jobId === 0).map(e => e.attempt)

    // At-least-once delivery means a stalled-recovery redelivery can legally
    // add a duplicate, so attempts are COUNTED AND BOUNDED, never asserted
    // exact. The upper bound is what proves `attempts: 3` is a ceiling.
    expect(new Set(attempts)).toEqual(new Set([1, 2, 3]))
    expect(attempts.length).toBeLessThanOrEqual(6)
  })
})

describe('invalid payloads dead-letter without consuming retries', () => {
  afterEach(async () => { await stopProcess() })

  it('rejects at enqueue and never queues the job', async () => {
    const proc = await startProcess({ role: 'both', driver: 'bullmq' })

    const result = await enqueueJobs(proc, {
      job: 'typed',
      count: 1,
      payload: { id: 42 },   // schema wants a string
    })

    expect(result.ids).toHaveLength(0)
    expect(result.errors.join(' ')).toMatch(/failed validation/)

    await new Promise(r => setTimeout(r, 500))
    expect(readLog()).toHaveLength(0)
  })

  it('applies the transform exactly once, in the worker', async () => {
    const proc = await startProcess({ role: 'both', driver: 'bullmq' })

    await enqueueJobs(proc, { job: 'typed', count: 1, payload: { id: '42' } })
    await waitForLog(entry => entry.jobId === 0)

    const entry = readLog().find(e => e.jobId === 0)!

    // Both halves. The handler must see a NUMBER (the transform ran) with the
    // right VALUE (it ran once, not twice — a second pass over 42 would have
    // failed z.string() and produced no log line at all).
    expect(entry.idType).toBe('number')
    expect(entry.idValue).toBe(42)
  })
})
```

- [ ] **Step 6: Run it to verify it fails against the old behaviour**

Before running the fixed code, confirm the retry scenario genuinely detects the bug this spec fixes. Temporarily revert the bullmq driver's `attempts: job.attempts` line from Task 10 to omit it, then:

```bash
REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle -t "retries a job that fails once"
```
Expected: FAIL — only attempt 1 appears, because BullMQ's default `attempts: 0` never retries. Restore the line.

Per the established convention, a lifecycle scenario does not count until it has been observed failing against the broken behaviour.

- [ ] **Step 7: Run the full lifecycle suite**

Run: `REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle`
Expected: PASS — the 10 existing scenarios plus the 4 new ones.

- [ ] **Step 8: Commit**

```bash
git add test/lifecycle/retry.test.ts playground/server/jobs/failing.ts playground/server/jobs/typed.ts playground/server/api/enqueue.post.ts
git commit -m "test: lifecycle coverage for retries and payload validation

Four scenarios against real Redis and the real built output: a job that
fails once and is retried; attempts as an enforced ceiling; an invalid
payload rejected at enqueue without ever being queued; and a transforming
schema applied exactly once, in the worker.

The retry scenario was observed failing with the bullmq driver's attempts
pass-through removed, per the convention that a lifecycle test does not
count until seen failing against the broken behaviour."
```

---

### Task 14: Playground, README and CHANGELOG

**Files:**
- Modify: `playground/server/jobs/slow.ts`, `playground/nuxt.config.ts`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new code surface. This task is where the retry behaviour change gets its prominent warning.

- [ ] **Step 1: Type the playground's `slow` job**

Rewrite `playground/server/jobs/slow.ts`, removing the two casts the harness relied on:

```ts
import { appendFileSync } from 'node:fs'
import { defineJob } from '#concierge-handlers'

export interface SlowPayload {
  seq: number
  durationMs?: number
}

export default defineJob<SlowPayload>({
  queue: 'default',
  handler: async (ctx) => {
    const { id, attempt, payload } = ctx
    await new Promise(r => setTimeout(r, payload.durationMs ?? 200))

    // Append-only so the test can read completions after the process dies.
    // CONCIERGE_TEST_LOG is a harness-only env var (test/lifecycle/harness.ts)
    // — without this guard, `pnpm dev`/a normal playground run has no value
    // for it, appendFileSync throws on an empty path, and every "slow" job
    // fails outside the lifecycle test harness.
    if (process.env.CONCIERGE_TEST_LOG) {
      appendFileSync(
        process.env.CONCIERGE_TEST_LOG,
        `${JSON.stringify({ jobId: payload.seq, attempt, pid: process.pid, id })}\n`,
      )
    }
  },
})
```

- [ ] **Step 2: Complete Task 12 Step 8 now that `slow` is typed**

Return to Task 12, Step 8 and Step 9 and run them. `enqueue('slow', { seq: 'not a number' })` must now be a compile error, and `enqueue('slwo', …)` must be rejected as an unknown name. Revert both deliberate errors afterwards.

This is the end-to-end proof that the generated map types real call sites. Do not skip it.

- [ ] **Step 3: Set retry defaults explicitly in the playground config**

In `playground/nuxt.config.ts`, add inside the `concierge` block:

```ts
    // Explicit rather than inherited so the lifecycle harness's timings are
    // not coupled to whatever the shipped default happens to be. `failing.ts`
    // overrides both per-job anyway.
    defaults: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 500 },
    },
```

- [ ] **Step 4: Document the job API in the README**

Add a section after the existing configuration docs. Include all four shapes so nobody has to infer one:

````markdown
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

Job names autocomplete and payloads are checked at compile time. A typo'd name or a wrong payload shape is a type error, not a runtime surprise.

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
````

- [ ] **Step 5: Write the CHANGELOG entry**

Add to `CHANGELOG.md` under a new unreleased heading. The retry change is a behaviour change and must not be buried:

```markdown
### ⚠️ Behaviour change: jobs are now retried by default

Failed jobs are retried **3 times total** with exponential backoff (1s, 2s). Previously the
`bullmq` driver passed no `attempts` at all, so BullMQ's default of `0` applied and **a failing
job was never retried in production** — while the `memory` driver used in dev and CI retried it
three times. The two now agree.

**A non-idempotent handler that previously failed once and stopped will now run its side effects
up to three times.** If you have handlers that charge cards, send email, or post to an external
API, make them idempotent or set `attempts: 1` on those jobs before upgrading.

Opt out globally:

```ts
concierge: { defaults: { attempts: 1 } }
```

### Features

- `defineJob<Payload>` types `ctx.payload`, and `useQueue().enqueue` is generic over a generated
  job map — job names autocomplete, and a wrong payload is a compile error.
- `input` accepts any Standard Schema validator (Zod, Valibot, ArkType) and is validated on both
  enqueue and execute. A validation failure is permanent and never retried.
- Per-job `attempts` and `backoff`, with `concierge.defaults` for the fleet.
- `ModuleOptions` now accepts partial nested config: `worker: { queues }` no longer fails to
  typecheck for missing `heartbeatInterval`/`heartbeatTtl`.

### Fixes

- Any API route that enqueued a job and returned a value failed `nuxi typecheck` with
  `Cannot find module '#concierge'`. Nitro's generated route types pull server handlers into the
  app program, where the nitro-scoped declaration was invisible.
- Fixed all 12 pre-existing `typecheck` errors and added `typecheck` to CI.
```

- [ ] **Step 6: Run the complete gate exactly as CI does**

Run:
```bash
pnpm install --frozen-lockfile
pnpm dev:prepare
pnpm lint
pnpm typecheck
pnpm test
pnpm test:types
REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle
pnpm prepack
```
Expected: every step PASS, `pnpm typecheck` reporting 0 errors.

- [ ] **Step 7: Verify the built output ships the new types**

Run:
```bash
grep -rn "ConciergeJobMap\|TypedQueue" dist/ | head
```
Expected: hits in the built runtime types. `ConciergeJobMap` is generated per-project at build time, so it will not appear as a filled map here — but `TypedQueue` must be present in `dist`, because the generated declaration references it via an absolute path into the installed package. If it is missing, the published module produces a broken declaration for consumers and `pnpm prepack` succeeding proves nothing about that.

- [ ] **Step 8: Dogfood the dev experience once, by hand**

Run `pnpm dev`, then in `playground/server/api/enqueue.post.ts` type `enqueue('` and confirm your editor offers `slow`, `failing` and `typed`. Then POST to the route and confirm jobs run:

```bash
curl -s -X POST localhost:3000/api/enqueue -H 'content-type: application/json' \
  -d '{"job":"typed","payload":{"id":"7"}}'
```
Expected: a JSON body with one id and an empty `errors` array. Then send an invalid payload and confirm it is rejected at the call site:

```bash
curl -s -X POST localhost:3000/api/enqueue -H 'content-type: application/json' \
  -d '{"job":"typed","payload":{"id":7}}'
```
Expected: `ids: []` and an `errors` entry mentioning validation.

- [ ] **Step 9: Commit**

```bash
git add playground/ README.md CHANGELOG.md
git commit -m "docs: document the typed job API and the retry behaviour change

Types the playground's slow job, removing the two payload casts the
lifecycle harness relied on. README covers all four defineJob shapes,
the InferInput/InferOutput distinction, and the idempotency requirement.

The CHANGELOG leads with the behaviour change: production went from
never retrying to three attempts, so non-idempotent handlers can now
repeat their side effects."
```

---

## Verification checklist

Run before considering the spec delivered:

```bash
pnpm install --frozen-lockfile
pnpm dev:prepare
pnpm lint                                              # 0 problems
pnpm typecheck                                         # 0 errors (was 12)
pnpm test                                              # unit, no Redis needed
pnpm test:types                                        # type-level assertions
REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle   # 14 scenarios
pnpm prepack                                           # builds
```

Then confirm each spec requirement has landed:

| Spec section | Delivered by |
| ------------ | ------------ |
| Public API — `defineJob` overloads | Task 6 |
| Public API — enqueue surface | Tasks 9, 12 |
| Codegen — `ConciergeJobMap` via ambient merging | Task 12 |
| Codegen — `{ nitro: true }` plus app graph | Task 4 |
| Codegen — registry replaces `routes` | Task 9 |
| Why there is no AST extraction | Nothing to build; eager imports retained. `src/templates.ts`'s `jobs` array is unchanged. |
| Validation data flow — raw in, output to handler | Tasks 7, 8, 9 |
| Error taxonomy — one class, `retryable = false` | Task 7 |
| Error taxonomy — consumer-side redaction | Task 7 |
| Retry contract — defaults and resolution | Tasks 3, 9, 10 |
| Driver conformance — memory matches bullmq | Task 11 |
| Driver conformance — sync unchanged, documented | Task 10 (SPI comment) |
| Testing — typecheck prerequisite | Tasks 1–4 |
| Testing — type tests | Tasks 5, 6, 12 |
| Testing — runtime both-halves table | Tasks 7, 8, 9 |
| Testing — lifecycle scenarios | Task 13 |
| Breaking changes — CHANGELOG | Task 14 |

## Deferred — do not build these

From the spec's deferred list. If a task seems to need one of these, stop and re-read the spec rather than adding it:

cron; dedup / `unique` / `uniqueId(payload)`; lazy handler loading and lean per-role bundles; the transactional outbox; per-job middleware and a `failed` hook; `jitter` on backoff; exposing `lockDuration`.

**AST extraction of `defineJob` metadata is dropped, not deferred.** Nothing in this plan should parse a job file's source.
