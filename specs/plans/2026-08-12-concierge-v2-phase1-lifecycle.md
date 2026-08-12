# nuxt-concierge v2 Phase 1 — Lifecycle & Process Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nuxt-concierge run workers in a dedicated process that drains in-flight jobs on SIGTERM instead of dropping them, behind a three-driver abstraction.

**Architecture:** One build artifact whose behaviour is selected by `CONCIERGE_ROLE` (`web` | `worker` | `both`). A single supervisor object owns all worker lifecycle and is driven by a nitro plugin that must register first. Shutdown splits in two: a synchronous signal listener flips state so the health endpoint reports 503, and Nitro's awaited `close` hook runs a drain sequence bounded by one deadline. Queue mechanics are delegated entirely to a driver (`sync`, `memory`, `bullmq`) — we never implement claim, lease, or stalled-recovery logic for the persistent driver.

**Tech Stack:** Nuxt 3/4 module (`@nuxt/kit`), Nitro plugins and hooks, BullMQ + ioredis, devalue, consola, vitest.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `specs/2026-08-12-concierge-v2-lifecycle-design.md`.

- **Node:** `>=22`. **Nuxt compatibility:** `^3.0.0 || ^4.0.0`.
- **All dependencies pinned** — no `^` or `~` ranges in `package.json`.
- **Never use devalue `uneval`.** Use `stringify`/`parse` only. `uneval` emits JS source requiring `eval`, which is a deserialization RCE if anything can write to Redis.
- **Payload envelope:** `{ v: 1, payload: devalue.stringify(userPayload) }`. An unrecognised `v` fails the job with a distinct, non-retryable error — never crash-loop, never silently discard.
- **Defaults:** `shutdownTimeout: 20_000`, `heartbeatInterval: 5_000`, `heartbeatTtl: 15_000`, queue concurrency `5`, `maxStalledCount: 3`, `stalledInterval: 30_000`.
- **Role default:** `both` in dev, `web` in production. Processing must be opted into.
- **`NITRO_SHUTDOWN_TIMEOUT`** defaults to `30_000` and is applied **twice sequentially** by Nitro (HTTP drain, then close hooks). `shutdownTimeout` must stay strictly below it.
- **The generated nitro plugin must be named with a `0.` prefix** so concierge's `close` hook registers — and therefore runs — before any DB-pool plugin tears down connections under a running job.
- **Delivery guarantee is at-least-once.** Never write a test asserting zero duplicates.
- **Use `nuxt.options.rootDir`, never `srcDir`, when resolving scan paths.** In Nuxt 4 `srcDir` defaults to `app/`, so `resolve(srcDir, 'server/...')` silently resolves to `app/server/...` and finds nothing. Credit: PR #10 by @gsxdsm.
- **Do not add `import { defineNitroPlugin } from "#imports"`** to generated nitro plugins. It is auto-imported, and the explicit import breaks resolution (notably with Prisma). Credit: PR #10 by @gsxdsm.

## File Structure

**Created:**

| Path | Responsibility |
| ---- | -------------- |
| `src/options.ts` | `ModuleOptions` type + `defu` defaults |
| `src/scan.ts` | Job file discovery (replaces `src/helplers/`) |
| `src/runtime/server/types.ts` | `WorkerRecord`, `ActiveJob`, `JobRecord`, `Role` |
| `src/runtime/server/role.ts` | `resolveRole()` — pure |
| `src/runtime/server/envelope.ts` | `encodePayload()` / `decodePayload()` — pure |
| `src/runtime/server/guardrails.ts` | `checkGuardrails()` — pure, returns diagnostics |
| `src/runtime/server/supervisor.ts` | The supervisor: state machine, consumers, heartbeat |
| `src/runtime/server/shutdown.ts` | Signal listener + bounded drain sequence |
| `src/runtime/server/drivers/types.ts` | `ConciergeDriver`, `Consumer`, `ConsumeOptions` |
| `src/runtime/server/drivers/index.ts` | `createDriver()` + `auto` resolution |
| `src/runtime/server/drivers/sync.ts` | Inline driver |
| `src/runtime/server/drivers/memory.ts` | In-process driver with claim/lease |
| `src/runtime/server/drivers/bullmq.ts` | BullMQ adapter |
| `src/runtime/server/handlers/defineJob.ts` | `defineJob()` |
| `src/runtime/server/utils/useQueue.ts` | `useQueue().enqueue()` |
| `src/runtime/server/routes/health.ts` | `GET /_concierge/health` |
| `src/runtime/server/middleware/role-gate.ts` | 503s non-health routes under `role: worker` |
| `test/lifecycle/harness.ts` | Child-process spawn/signal/assert helpers |

**Modified:** `src/module.ts`, `src/templates.ts`, `src/runtime/server/routes/ui-handler.ts`, `package.json`, `.github/workflows/ci.yml`, `README.md`, `playground/`.

**Deleted:** `src/helplers/` (typo'd directory), `src/runtime/server/handlers/defineQueue.ts`, `defineWorker.ts`, `defineCron.ts`, `src/runtime/server/utils/concierge.ts`.

---

### Task 1: Toolchain bump to Nuxt 4-compatible

The spec lists this as a phase 1 prerequisite. `@nuxt/module-builder@0.5.5` cannot drive modern `nuxi`, which is why `pnpm.overrides` currently pins `nuxi` to 3.10.0. Nothing else in this plan can be verified against Nuxt 4 until this lands.

**Files:**
- Modify: `package.json`
- Modify: `playground/nuxt.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a build that runs under Nuxt 4 with no `pnpm.overrides`. All later tasks assume `pnpm dev:prepare`, `pnpm lint`, `pnpm test`, and `pnpm prepack` pass.

- [ ] **Step 1: Record the current baseline**

```bash
pnpm dev:prepare && pnpm lint && pnpm test && pnpm prepack
```

Expected: all pass. Note the `dist` size from `prepack` output so you can compare after.

- [ ] **Step 2: Remove the nuxi override and bump the toolchain**

Edit `package.json`. Delete the entire `pnpm.overrides` block, keeping `pnpm.onlyBuiltDependencies`. Then set these exact versions (pinned, no ranges):

```json
"dependencies": {
  "@nuxt/kit": "4.5.2",
  "bullmq": "5.63.0",
  "consola": "3.4.2",
  "defu": "6.1.7",
  "devalue": "5.4.1",
  "fast-glob": "3.3.3",
  "ioredis": "5.9.0",
  "ufo": "1.6.4"
},
"devDependencies": {
  "@nuxt/module-builder": "1.0.3",
  "@nuxt/schema": "4.5.2",
  "@nuxt/test-utils": "4.1.0",
  "@types/node": "24.10.1",
  "eslint": "9.42.0",
  "nuxt": "4.5.2",
  "typescript": "5.9.3",
  "vitest": "4.1.10"
}
```

Note the changes beyond version numbers: `devalue` is **added** (needed by Task 3), and `colorette`, `pluralize`, `@types/pluralize`, and `@nuxt/devtools` are **removed** — the first three are only used by log messages being deleted in Task 13, and devtools is not used until spec 4. Keep `@bull-board/*` pinned as they are; BullBoard stays mounted through phase 1.

- [ ] **Step 3: Install and observe what breaks**

```bash
pnpm install 2>&1 | tail -20
pnpm dev:prepare 2>&1 | tail -30
```

Expected: `install` succeeds. `dev:prepare` may fail — that is the point of this step. Likely failures and their fixes:

- **`@nuxt/eslint-config` incompatible with eslint 9.** Delete `.eslintrc` and `.eslintignore`, remove `@nuxt/eslint-config` from `devDependencies`, add `@nuxt/eslint-config` at `1.16.0`, and create `eslint.config.mjs`:

```js
import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

export default createConfigForNuxt()
  .append({
    ignores: ['dist', 'node_modules', '.nuxt', '.output', 'playground/.nuxt', 'docs/.nuxt'],
  })
```

- **`compatibilityDate` warning.** Add to `playground/nuxt.config.ts`:

```ts
compatibilityDate: '2026-08-12',
```

- **module-builder 1.x stricter about `exports`.** If it complains, no action needed yet — Task 13 revisits packaging.

- [ ] **Step 4: Verify the full pipeline**

```bash
pnpm lint && pnpm test && pnpm prepack && pnpm dev:build
```

Expected: all pass. `pnpm dev:build` is new to this checklist and important — it proves the playground builds under Nuxt 4, which is what every later task's integration test depends on.

- [ ] **Step 5: See the Nuxt 4 scan-path hazard for yourself**

This confirms the Global Constraint about `rootDir` before Task 7 depends on it.

```bash
grep -n "srcDir" src/helplers/scan-folder.ts
node -e "console.log('Nuxt 4 srcDir default:', 'app/')"
```

Expected: the grep prints the `resolve(nuxt.options.srcDir, path)` line. Under Nuxt 4 that resolves to `<rootDir>/app/server/concierge/workers`, which does not exist — so the scan returns an empty array and no error is raised. Leave the file alone; Task 7 replaces it. You have now seen the bug you must not reintroduce.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml eslint.config.mjs playground/nuxt.config.ts
git rm -f .eslintrc .eslintignore
git commit -m "build: bump toolchain to Nuxt 4 and drop the nuxi override

@nuxt/module-builder 1.x can drive modern nuxi, so the pnpm.overrides pin
on nuxi 3.10.0 is no longer needed. Adds devalue for the payload envelope
and drops colorette, pluralize and @nuxt/devtools, which are unused after
the phase 1 rewrite. Migrates eslint to flat config for eslint 9."
```

---

### Task 2: Options schema and role resolution

**Files:**
- Create: `src/options.ts`
- Create: `src/runtime/server/types.ts`
- Create: `src/runtime/server/role.ts`
- Create: `test/unit/role.test.ts`
- Modify: `src/module.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Role = 'web' | 'worker' | 'both'`
  - `resolveRole(input: { env?: string; config?: string; isDev: boolean }): Role` — throws `Error` on an invalid value
  - `interface ModuleOptions` with `driver`, `connection`, `role`, `worker.{queues,shutdownTimeout,heartbeatInterval,heartbeatTtl}`, `bullmq.{maxStalledCount,stalledInterval}`
  - `interface WorkerRecord`, `interface ActiveJob` (consumed by Tasks 4–6, 8)

- [ ] **Step 1: Write the failing test**

Create `test/unit/role.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveRole } from '../../src/runtime/server/role'

describe('resolveRole', () => {
  it('defaults to both in dev', () => {
    expect(resolveRole({ isDev: true })).toBe('both')
  })

  it('defaults to web in production', () => {
    expect(resolveRole({ isDev: false })).toBe('web')
  })

  it('prefers env over config', () => {
    expect(resolveRole({ env: 'worker', config: 'web', isDev: false })).toBe('worker')
  })

  it('falls back to config when env is absent', () => {
    expect(resolveRole({ config: 'both', isDev: false })).toBe('both')
  })

  it('ignores an empty env string', () => {
    expect(resolveRole({ env: '', config: 'worker', isDev: false })).toBe('worker')
  })

  it('throws on an invalid env value rather than silently doing nothing', () => {
    expect(() => resolveRole({ env: 'workers', isDev: false }))
      .toThrow(/CONCIERGE_ROLE.*"workers".*web \| worker \| both/)
  })

  it('throws on an invalid config value', () => {
    expect(() => resolveRole({ config: 'Worker', isDev: false }))
      .toThrow(/concierge\.role.*"Worker"/)
  })
})
```

The typo case is the important one. A `CONCIERGE_ROLE=workers` typo would otherwise produce a process that starts no consumers *and* suppresses the no-worker warning — defeating the safeguard the production default exists to provide.

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/role.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/server/role`.

- [ ] **Step 3: Create the shared runtime types**

Create `src/runtime/server/types.ts`:

```ts
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
  role: 'worker' | 'both'
  queues: string[]
  concurrency: Record<string, number>
  version: string
  startedAt: number
  lastHeartbeat: number
  state: 'running' | 'draining'
  active: ActiveJob[]
}

/** What a handler receives. Untyped payload in phase 1; spec 3 makes it generic. */
export interface JobContext {
  id: string
  name: string
  queue: string
  attempt: number
  payload: unknown
}

export type JobHandler = (ctx: JobContext) => Promise<void> | void

export interface JobDefinition {
  name: string
  queue: string
  handler: JobHandler
}
```

- [ ] **Step 4: Implement `resolveRole`**

Create `src/runtime/server/role.ts`:

```ts
import type { Role } from './types'

const ROLES: readonly Role[] = ['web', 'worker', 'both']

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

export interface ResolveRoleInput {
  env?: string
  config?: string
  isDev: boolean
}

/**
 * Precedence: CONCIERGE_ROLE env -> concierge.role config -> default.
 *
 * The default is `both` in dev and `web` in production: processing must be
 * opted into, so the failure mode is "jobs pile up" (loud, and caught by the
 * no-worker warning) rather than "every web instance also processes jobs"
 * (silent, and surfaces only as duplicate side effects).
 */
export const resolveRole = ({ env, config, isDev }: ResolveRoleInput): Role => {
  if (env) {
    if (!isRole(env)) {
      throw new Error(
        `[nuxt-concierge] CONCIERGE_ROLE is "${env}", which is not a valid role. Expected one of: web | worker | both`,
      )
    }
    return env
  }

  if (config) {
    if (!isRole(config)) {
      throw new Error(
        `[nuxt-concierge] concierge.role is "${config}", which is not a valid role. Expected one of: web | worker | both`,
      )
    }
    return config
  }

  return isDev ? 'both' : 'web'
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `pnpm vitest run test/unit/role.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Define the module options**

Create `src/options.ts`:

```ts
import type { Role } from './runtime/server/types'

export type DriverName = 'auto' | 'sync' | 'memory' | 'bullmq'

export interface ConnectionOptions {
  url?: string
  host?: string
  port?: number
  password?: string
}

export interface WorkerOptions {
  /**
   * Queue name -> concurrency. Does double duty in phase 1: it is both the
   * concurrency map and the queue declaration, since defineQueue is gone.
   * A job naming a queue absent from this map is a boot-time error.
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

export interface ModuleOptions {
  driver: DriverName
  connection: ConnectionOptions
  role?: Role
  worker: WorkerOptions
  bullmq: BullmqOptions
  /** BullBoard dashboard. Unchanged in phase 1; replaced in spec 4. */
  managementUI?: boolean
}

export const moduleDefaults: ModuleOptions = {
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
  managementUI: process.env.NODE_ENV === 'development',
}
```

- [ ] **Step 7: Add version resolution**

The worker registry needs a `version` so a rolling deploy shows old and new workers side by side. Add to `src/runtime/server/role.ts` (it lives beside the other pure boot-time resolvers):

```ts
export interface ResolveVersionInput {
  env?: string
  packageVersion?: string
}

/**
 * CONCIERGE_VERSION wins so CI can inject a git SHA into the deployed process,
 * then the host app's package.json version, then a placeholder.
 */
export const resolveVersion = ({ env, packageVersion }: ResolveVersionInput): string =>
  env?.trim() || packageVersion?.trim() || 'unknown'
```

Append to `test/unit/role.test.ts`:

```ts
import { resolveVersion } from '../../src/runtime/server/role'

describe('resolveVersion', () => {
  it('prefers CONCIERGE_VERSION so CI can inject a git sha', () => {
    expect(resolveVersion({ env: 'abc1234', packageVersion: '2.0.0' })).toBe('abc1234')
  })

  it('falls back to the host package version', () => {
    expect(resolveVersion({ packageVersion: '2.0.0' })).toBe('2.0.0')
  })

  it('falls back to "unknown" rather than empty string', () => {
    expect(resolveVersion({})).toBe('unknown')
    expect(resolveVersion({ env: '  ', packageVersion: '' })).toBe('unknown')
  })
})
```

Run: `pnpm vitest run test/unit/role.test.ts` — expected PASS, 10 tests.

- [ ] **Step 8: Wire options into the module and expose role and version on runtimeConfig**

Replace the `ModuleOptions` interface and `defaults` in `src/module.ts` with imports from `./options`, and inside `setup()` — after the existing `runtimeConfig.concierge` assignment — add:

```ts
import { readFileSync } from 'node:fs'
import { resolveRole } from './runtime/server/role'

// ...inside setup()
const role = resolveRole({
  env: process.env.CONCIERGE_ROLE,
  config: options.role,
  isDev: nuxt.options.dev,
})

// Read at build time; the runtime lets CONCIERGE_VERSION override it, because
// a git SHA is usually injected into the deployed process, not the build.
let packageVersion: string | undefined
try {
  packageVersion = JSON.parse(
    readFileSync(`${nuxt.options.rootDir}/package.json`, 'utf8'),
  ).version
}
catch {
  packageVersion = undefined
}

nuxt.options.runtimeConfig.concierge = defu(
  { role, version: packageVersion ?? 'unknown' },
  nuxt.options.runtimeConfig.concierge,
  options,
)

logger.info(`Role: ${role}`)
```

Resolving the role at build time and writing it to `runtimeConfig` means an invalid `CONCIERGE_ROLE` fails the build, not the tenth request. Note the runtime must **re-resolve** both values from env at boot (Task 8), because `CONCIERGE_ROLE` and `CONCIERGE_VERSION` differ per process while the build artifact is shared — the build-time values are only the baked-in defaults.

- [ ] **Step 9: Verify and commit**

```bash
pnpm dev:prepare && pnpm lint && pnpm test
git add src/options.ts src/runtime/server/types.ts src/runtime/server/role.ts test/unit/role.test.ts src/module.ts
git commit -m "feat: add role resolution and the v2 options schema

CONCIERGE_ROLE > concierge.role > default (both in dev, web in prod).
Invalid values throw at build time rather than yielding a process that
starts no consumers and also mutes the no-worker warning."
```

---

### Task 3: Payload envelope

**Files:**
- Create: `src/runtime/server/envelope.ts`
- Create: `test/unit/envelope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `encodePayload(payload: unknown): Envelope`
  - `decodePayload(envelope: unknown): unknown` — throws `UnsupportedEnvelopeError`
  - `class UnsupportedEnvelopeError extends Error` with `retryable = false`
  - `interface Envelope { v: number; payload: string }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/envelope.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { encodePayload, decodePayload, UnsupportedEnvelopeError } from '../../src/runtime/server/envelope'

describe('payload envelope', () => {
  it('round-trips plain objects', () => {
    const payload = { to: 'a@b.com', count: 3 }
    expect(decodePayload(encodePayload(payload))).toEqual(payload)
  })

  it('preserves Date, which JSON silently mangles', () => {
    const at = new Date('2026-08-12T10:00:00.000Z')
    const out = decodePayload(encodePayload({ at })) as { at: Date }
    expect(out.at).toBeInstanceOf(Date)
    expect(out.at.toISOString()).toBe(at.toISOString())
  })

  it('preserves Map, Set and undefined', () => {
    const payload = {
      map: new Map([['k', 1]]),
      set: new Set([1, 2]),
      nothing: undefined,
    }
    const out = decodePayload(encodePayload(payload)) as typeof payload
    expect(out.map).toBeInstanceOf(Map)
    expect(out.map.get('k')).toBe(1)
    expect(out.set).toBeInstanceOf(Set)
    expect(out.set.has(2)).toBe(true)
    expect('nothing' in out).toBe(true)
    expect(out.nothing).toBeUndefined()
  })

  it('stamps the envelope version', () => {
    expect(encodePayload({}).v).toBe(1)
  })

  it('produces a JSON-serialisable envelope so BullMQ can store it', () => {
    const envelope = encodePayload({ at: new Date() })
    expect(() => JSON.parse(JSON.stringify(envelope))).not.toThrow()
  })

  it('throws a non-retryable error on an unknown envelope version', () => {
    const err = (() => {
      try {
        decodePayload({ v: 99, payload: '[]' })
        return null
      }
      catch (e) {
        return e as UnsupportedEnvelopeError
      }
    })()

    expect(err).toBeInstanceOf(UnsupportedEnvelopeError)
    expect(err!.retryable).toBe(false)
    expect(err!.message).toMatch(/envelope version 99/)
  })

  it('throws on a malformed envelope rather than returning undefined', () => {
    expect(() => decodePayload({ nope: true })).toThrow(UnsupportedEnvelopeError)
    expect(() => decodePayload(null)).toThrow(UnsupportedEnvelopeError)
  })
})
```

The unknown-version test matters because the failure it guards is a deploy that changes the payload shape while old-shape jobs are still queued. Without a distinct non-retryable error the worker either crash-loops or silently drops the job.

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/envelope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the envelope**

Create `src/runtime/server/envelope.ts`:

```ts
import { parse, stringify } from 'devalue'

export const ENVELOPE_VERSION = 1

export interface Envelope {
  v: number
  payload: string
}

/**
 * Thrown when a payload cannot be decoded. Not retryable: retrying a payload
 * this process cannot understand will fail identically every time, so the job
 * must fail once and stay failed rather than crash-loop the worker.
 */
export class UnsupportedEnvelopeError extends Error {
  readonly retryable = false

  constructor(message: string) {
    super(`[nuxt-concierge] ${message}`)
    this.name = 'UnsupportedEnvelopeError'
  }
}

/**
 * devalue `stringify` (NOT `uneval`) — uneval emits JS source requiring eval,
 * which is a deserialization RCE if anything can write to the queue backend.
 * stringify output is JSON-compatible, so BullMQ can store it directly.
 */
export const encodePayload = (payload: unknown): Envelope => ({
  v: ENVELOPE_VERSION,
  payload: stringify(payload),
})

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === 'object'
  && value !== null
  && typeof (value as Envelope).v === 'number'
  && typeof (value as Envelope).payload === 'string'

export const decodePayload = (envelope: unknown): unknown => {
  if (!isEnvelope(envelope)) {
    throw new UnsupportedEnvelopeError(
      `Job payload is not a concierge envelope: ${JSON.stringify(envelope)?.slice(0, 200)}`,
    )
  }

  if (envelope.v !== ENVELOPE_VERSION) {
    throw new UnsupportedEnvelopeError(
      `Cannot decode envelope version ${envelope.v}; this build understands version ${ENVELOPE_VERSION}. `
      + `This usually means a deploy changed the payload format while older jobs were still queued.`,
    )
  }

  return parse(envelope.payload)
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run test/unit/envelope.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/server/envelope.ts test/unit/envelope.test.ts
git commit -m "feat: add devalue payload envelope with a version guard

Preserves Date, Map, Set and undefined. Uses stringify rather than uneval,
which would require eval on the consumer side. An unknown envelope version
raises a non-retryable error so a format change mid-deploy fails one job
loudly instead of crash-looping the worker."
```

---

### Task 4: Driver SPI and the `sync` driver

**Files:**
- Create: `src/runtime/server/drivers/types.ts`
- Create: `src/runtime/server/drivers/sync.ts`
- Create: `src/runtime/server/drivers/index.ts`
- Create: `test/unit/drivers/sync.test.ts`
- Create: `test/unit/drivers/resolve.test.ts`

**Interfaces:**
- Consumes: `JobContext`, `JobHandler`, `WorkerRecord`, `ActiveJob` (Task 2); `encodePayload`, `decodePayload` (Task 3).
- Produces:
  - `interface ConciergeDriver` and `interface Consumer` exactly as in the spec
  - `interface EnqueueOptions { name: string; payload: unknown }`
  - `resolveDriverName(input: { configured: DriverName; hasConnection: boolean; isProduction: boolean }): Exclude<DriverName, 'auto'>` — throws in production when `auto` has no connection
  - `createDriver(name, opts): ConciergeDriver`
  - `createSyncDriver(): ConciergeDriver`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/drivers/resolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveDriverName } from '../../../src/runtime/server/drivers'

describe('resolveDriverName', () => {
  it('passes explicit names through untouched', () => {
    expect(resolveDriverName({ configured: 'memory', hasConnection: true, isProduction: true })).toBe('memory')
    expect(resolveDriverName({ configured: 'sync', hasConnection: false, isProduction: false })).toBe('sync')
  })

  it('auto resolves to bullmq when a connection is present', () => {
    expect(resolveDriverName({ configured: 'auto', hasConnection: true, isProduction: true })).toBe('bullmq')
  })

  it('auto resolves to memory outside production when no connection is present', () => {
    expect(resolveDriverName({ configured: 'auto', hasConnection: false, isProduction: false })).toBe('memory')
  })

  it('auto throws a targeted error in production with no connection', () => {
    // Without this the memory driver would be selected, then guardrail 1 would
    // throw a confusing crossProcess capability error when the real problem is
    // a missing REDIS_URL.
    expect(() => resolveDriverName({ configured: 'auto', hasConnection: false, isProduction: true }))
      .toThrow(/REDIS_URL/)
  })
})
```

Create `test/unit/drivers/sync.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createSyncDriver } from '../../../src/runtime/server/drivers/sync'

describe('sync driver', () => {
  it('reports its capabilities honestly', () => {
    const d = createSyncDriver()
    expect(d.name).toBe('sync')
    expect(d.capabilities).toEqual({ persistent: false, crossProcess: false })
  })

  it('runs the handler inline during enqueue', async () => {
    const d = createSyncDriver()
    const seen: unknown[] = []
    d.registerHandler('mail', 'send', async ctx => { seen.push(ctx.payload) })
    await d.init()

    await d.enqueue('mail', { name: 'send', payload: { to: 'a@b.com' } })

    expect(seen).toEqual([{ to: 'a@b.com' }])
  })

  it('propagates handler errors to the caller of enqueue', async () => {
    const d = createSyncDriver()
    d.registerHandler('mail', 'send', async () => { throw new Error('boom') })
    await d.init()

    await expect(d.enqueue('mail', { name: 'send', payload: {} })).rejects.toThrow('boom')
  })

  it('round-trips the payload through the envelope so Dates survive', async () => {
    const d = createSyncDriver()
    let got: any
    d.registerHandler('q', 'j', async ctx => { got = ctx.payload })
    await d.init()

    await d.enqueue('q', { name: 'j', payload: { at: new Date('2026-01-01T00:00:00.000Z') } })

    expect(got.at).toBeInstanceOf(Date)
  })

  it('throws when enqueueing a job with no registered handler', async () => {
    const d = createSyncDriver()
    await d.init()
    await expect(d.enqueue('q', { name: 'missing', payload: {} })).rejects.toThrow(/no handler/i)
  })

  it('has an inert consumer and an empty registry', async () => {
    const d = createSyncDriver()
    await d.init()
    const c = d.consume('q', { concurrency: 1 }, vi.fn())

    expect(c.activeCount()).toBe(0)
    expect(c.active()).toEqual([])
    await expect(c.pause()).resolves.toBeUndefined()
    await expect(c.drain()).resolves.toBeUndefined()
    await expect(d.workers()).resolves.toEqual([])
    await expect(d.depth('q')).resolves.toBe(0)
  })
})
```

- [ ] **Step 2: Run them and verify they fail**

Run: `pnpm vitest run test/unit/drivers`
Expected: FAIL — modules not found.

- [ ] **Step 3: Define the SPI**

Create `src/runtime/server/drivers/types.ts`:

```ts
import type { ActiveJob, JobHandler, WorkerRecord } from '../types'

export interface DriverCapabilities {
  /** Survives process restart. */
  persistent: boolean
  /** A process that runs no workers can still read this driver's data. */
  crossProcess: boolean
}

export interface EnqueueOptions {
  name: string
  payload: unknown
  delay?: number
}

export interface ConsumeOptions {
  concurrency: number
}

export interface Consumer {
  /**
   * Stop fetching new jobs. MUST resolve immediately and MUST NOT await active
   * jobs — the shutdown budget does not start counting until this resolves, so
   * a blocking pause() spends the entire budget before the drain begins.
   */
  pause: () => Promise<void>
  /** Resolves when in-flight reaches zero. */
  drain: () => Promise<void>
  close: (force: boolean) => Promise<void>
  activeCount: () => number
  active: () => ActiveJob[]
}

export interface ConciergeDriver {
  readonly name: string
  readonly capabilities: DriverCapabilities

  init: () => Promise<void>
  close: (force: boolean) => Promise<void>

  /** Associates a handler with a queue+name. Called at boot for every scanned job. */
  registerHandler: (queue: string, name: string, handler: JobHandler) => void

  enqueue: (queue: string, job: EnqueueOptions) => Promise<{ id: string }>
  consume: (queue: string, opts: ConsumeOptions, onJob?: JobHandler) => Consumer
  depth: (queue: string) => Promise<number>

  heartbeat: (record: WorkerRecord, ttlMs: number) => Promise<void>
  deregister: (id: string) => Promise<void>
  workers: () => Promise<WorkerRecord[]>
}
```

- [ ] **Step 4: Implement the sync driver**

Create `src/runtime/server/drivers/sync.ts`:

```ts
import { decodePayload, encodePayload } from '../envelope'
import type { JobHandler } from '../types'
import type { ConciergeDriver, Consumer } from './types'

const inertConsumer: Consumer = {
  pause: async () => {},
  drain: async () => {},
  close: async () => {},
  activeCount: () => 0,
  active: () => [],
}

/**
 * Executes handlers inline in the caller. Two deliberate consequences:
 * handler errors propagate to whoever called enqueue, and retries do not
 * apply. Both make tests fail loudly instead of swallowing failures.
 */
export const createSyncDriver = (): ConciergeDriver => {
  const handlers = new Map<string, JobHandler>()
  let counter = 0

  const key = (queue: string, name: string) => `${queue}::${name}`

  return {
    name: 'sync',
    capabilities: { persistent: false, crossProcess: false },

    init: async () => {},
    close: async () => {},

    registerHandler: (queue, name, handler) => {
      handlers.set(key(queue, name), handler)
    },

    enqueue: async (queue, job) => {
      const handler = handlers.get(key(queue, job.name))
      if (!handler) {
        throw new Error(`[nuxt-concierge] no handler registered for "${job.name}" on queue "${queue}"`)
      }

      // Round-trip through the envelope even though we never leave the process,
      // so sync and async drivers agree on what survives serialisation.
      const id = `sync-${++counter}`
      await handler({
        id,
        name: job.name,
        queue,
        attempt: 1,
        payload: decodePayload(encodePayload(job.payload)),
      })

      return { id }
    },

    consume: () => inertConsumer,
    depth: async () => 0,

    heartbeat: async () => {},
    deregister: async () => {},
    workers: async () => [],
  }
}
```

- [ ] **Step 5: Implement the driver factory**

Create `src/runtime/server/drivers/index.ts`:

```ts
import type { DriverName } from '../../../options'
import { createSyncDriver } from './sync'
import type { ConciergeDriver } from './types'

export type * from './types'

export type ResolvedDriverName = Exclude<DriverName, 'auto'>

export interface ResolveDriverInput {
  configured: DriverName
  hasConnection: boolean
  isProduction: boolean
}

/**
 * `auto` is the zero-config adoption lever, not a production portability
 * feature. It must not silently fall back to `memory` in production: the prod
 * role default is `web`, and the crossProcess guardrail would then throw a
 * capability error that hides the real problem (a missing connection URL).
 */
export const resolveDriverName = (
  { configured, hasConnection, isProduction }: ResolveDriverInput,
): ResolvedDriverName => {
  if (configured !== 'auto') return configured
  if (hasConnection) return 'bullmq'

  if (isProduction) {
    throw new Error(
      '[nuxt-concierge] driver is "auto" but no connection URL was found in production. '
      + 'Set REDIS_URL (or concierge.connection), or choose a driver explicitly with concierge.driver.',
    )
  }

  return 'memory'
}

export interface CreateDriverOptions {
  connection?: { url?: string, host?: string, port?: number, password?: string }
  bullmq?: { maxStalledCount: number, stalledInterval: number }
}

export const createDriver = async (
  name: ResolvedDriverName,
  opts: CreateDriverOptions = {},
): Promise<ConciergeDriver> => {
  switch (name) {
    case 'sync':
      return createSyncDriver()
    case 'memory': {
      const { createMemoryDriver } = await import('./memory')
      return createMemoryDriver()
    }
    case 'bullmq': {
      const { createBullmqDriver } = await import('./bullmq')
      return createBullmqDriver(opts)
    }
  }
}
```

`createDriver` is async and uses dynamic imports so a `sync`- or `memory`-only deployment never loads `bullmq`/`ioredis`. Tasks 5 and 6 create the modules referenced here; until then those branches throw at import time, which no test in this task exercises.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pnpm vitest run test/unit/drivers`
Expected: PASS — 10 tests.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/drivers test/unit/drivers
git commit -m "feat: add the phase 1 driver SPI and the sync driver

pause() and drain() are separate operations: the shutdown budget cannot
start until fetching has stopped, so pause() must never await active jobs.

resolveDriverName refuses to fall back to memory in production, which would
otherwise surface as a confusing crossProcess capability error rather than
the actual missing REDIS_URL."
```

---

### Task 5: `memory` driver

The only driver where we write claim/lease logic. Acceptable because crash-correctness is explicitly not a goal for it — it exists for `pnpm dev` and tests.

**Files:**
- Create: `src/runtime/server/drivers/memory.ts`
- Create: `test/unit/drivers/memory.test.ts`

**Interfaces:**
- Consumes: `ConciergeDriver`, `Consumer`, `ConsumeOptions` (Task 4); envelope (Task 3).
- Produces: `createMemoryDriver(): ConciergeDriver` with `{ persistent: false, crossProcess: false }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/drivers/memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createMemoryDriver } from '../../../src/runtime/server/drivers/memory'
import type { WorkerRecord } from '../../../src/runtime/server/types'

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

const record = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id: 'w1',
  hostname: 'h',
  pid: 1,
  role: 'worker',
  queues: ['default'],
  concurrency: { default: 1 },
  version: 'test',
  startedAt: Date.now(),
  lastHeartbeat: Date.now(),
  state: 'running',
  active: [],
  ...over,
})

describe('memory driver', () => {
  it('reports its capabilities honestly', () => {
    expect(createMemoryDriver().capabilities).toEqual({ persistent: false, crossProcess: false })
  })

  it('processes an enqueued job through a consumer', async () => {
    const d = createMemoryDriver()
    await d.init()
    const seen: string[] = []
    d.consume('default', { concurrency: 1 }, async ctx => { seen.push(ctx.name) })

    await d.enqueue('default', { name: 'work', payload: { a: 1 } })
    await tick(50)

    expect(seen).toEqual(['work'])
  })

  it('respects concurrency', async () => {
    const d = createMemoryDriver()
    await d.init()
    let inFlight = 0
    let peak = 0
    d.consume('default', { concurrency: 2 }, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick(40)
      inFlight--
    })

    for (let i = 0; i < 6; i++) await d.enqueue('default', { name: 'j', payload: {} })
    await tick(300)

    expect(peak).toBe(2)
  })

  it('reports depth for pending jobs', async () => {
    const d = createMemoryDriver()
    await d.init()
    await d.enqueue('default', { name: 'j', payload: {} })
    await d.enqueue('default', { name: 'j', payload: {} })

    expect(await d.depth('default')).toBe(2)
  })

  it('pause stops fetching but resolves immediately while a job is active', async () => {
    const d = createMemoryDriver()
    await d.init()
    let started = 0
    const c = d.consume('default', { concurrency: 1 }, async () => {
      started++
      await tick(120)
    })

    await d.enqueue('default', { name: 'slow', payload: {} })
    await d.enqueue('default', { name: 'never', payload: {} })
    await tick(30)

    const before = Date.now()
    await c.pause()
    // Must not have waited for the 120ms job.
    expect(Date.now() - before).toBeLessThan(60)
    expect(c.activeCount()).toBe(1)

    await c.drain()
    expect(c.activeCount()).toBe(0)
    expect(started).toBe(1) // the second job was never fetched
  })

  it('drain resolves once in-flight reaches zero', async () => {
    const d = createMemoryDriver()
    await d.init()
    const c = d.consume('default', { concurrency: 1 }, async () => { await tick(60) })
    await d.enqueue('default', { name: 'j', payload: {} })
    await tick(20)

    await c.pause()
    await c.drain()

    expect(c.activeCount()).toBe(0)
  })

  it('exposes active jobs while running', async () => {
    const d = createMemoryDriver()
    await d.init()
    const c = d.consume('default', { concurrency: 1 }, async () => { await tick(80) })
    await d.enqueue('default', { name: 'visible', payload: {} })
    await tick(30)

    const active = c.active()
    expect(active).toHaveLength(1)
    expect(active[0]!.name).toBe('visible')
    expect(active[0]!.queue).toBe('default')

    await c.close(true)
  })

  it('stores and expires worker records by TTL', async () => {
    const d = createMemoryDriver()
    await d.init()

    await d.heartbeat(record({ id: 'alive' }), 10_000)
    await d.heartbeat(record({ id: 'stale', lastHeartbeat: Date.now() - 60_000 }), 10_000)

    const ids = (await d.workers()).map(w => w.id)
    expect(ids).toContain('alive')
    expect(ids).not.toContain('stale')
  })

  it('deregisters a worker record', async () => {
    const d = createMemoryDriver()
    await d.init()
    await d.heartbeat(record({ id: 'w9' }), 10_000)
    await d.deregister('w9')

    expect(await d.workers()).toEqual([])
  })

  it('retries a failing job up to maxAttempts', async () => {
    const d = createMemoryDriver()
    await d.init()
    let attempts = 0
    d.consume('default', { concurrency: 1 }, async () => {
      attempts++
      throw new Error('always fails')
    })

    await d.enqueue('default', { name: 'bad', payload: {} })
    await tick(300)

    expect(attempts).toBe(3)
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/drivers/memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the memory driver**

Create `src/runtime/server/drivers/memory.ts`:

```ts
import { decodePayload, encodePayload } from '../envelope'
import type { ActiveJob, JobHandler, WorkerRecord } from '../types'
import type { ConciergeDriver, Consumer } from './types'

const MAX_ATTEMPTS = 3
const POLL_MS = 10

interface QueuedJob {
  id: string
  name: string
  queue: string
  envelope: { v: number, payload: string }
  attempt: number
  runAt: number
}

/**
 * In-process queue with a real claim loop so delays, retries and concurrency
 * behave like the persistent driver. Loses everything on process death — that
 * is acceptable for a dev/test driver and is stated loudly in the docs.
 */
export const createMemoryDriver = (): ConciergeDriver => {
  const pending = new Map<string, QueuedJob[]>()
  const handlers = new Map<string, JobHandler>()
  const records = new Map<string, { record: WorkerRecord, expiresAt: number }>()
  const consumers: Array<{ stop: () => void }> = []
  let counter = 0

  const key = (queue: string, name: string) => `${queue}::${name}`
  const queueOf = (queue: string) => {
    if (!pending.has(queue)) pending.set(queue, [])
    return pending.get(queue)!
  }

  return {
    name: 'memory',
    capabilities: { persistent: false, crossProcess: false },

    init: async () => {},

    close: async () => {
      for (const c of consumers) c.stop()
      pending.clear()
    },

    registerHandler: (queue, name, handler) => {
      handlers.set(key(queue, name), handler)
    },

    enqueue: async (queue, job) => {
      const id = `mem-${++counter}`
      queueOf(queue).push({
        id,
        name: job.name,
        queue,
        envelope: encodePayload(job.payload),
        attempt: 0,
        runAt: Date.now() + (job.delay ?? 0),
      })
      return { id }
    },

    consume: (queue, opts, onJob): Consumer => {
      const active = new Map<string, ActiveJob>()
      let paused = false
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const resolveHandler = (name: string): JobHandler | undefined =>
        onJob ?? handlers.get(key(queue, name))

      const run = async (job: QueuedJob) => {
        active.set(job.id, { jobId: job.id, queue, name: job.name, startedAt: Date.now() })
        try {
          const handler = resolveHandler(job.name)
          if (!handler) throw new Error(`[nuxt-concierge] no handler for "${job.name}" on "${queue}"`)

          await handler({
            id: job.id,
            name: job.name,
            queue,
            attempt: job.attempt,
            payload: decodePayload(job.envelope),
          })
        }
        catch (error) {
          const fatal = (error as { retryable?: boolean }).retryable === false
          if (!fatal && job.attempt < MAX_ATTEMPTS) {
            queueOf(queue).push({ ...job, runAt: Date.now() })
          }
        }
        finally {
          active.delete(job.id)
        }
      }

      const loop = () => {
        if (stopped) return

        if (!paused) {
          const q = queueOf(queue)
          while (active.size < opts.concurrency) {
            const idx = q.findIndex(j => j.runAt <= Date.now())
            if (idx === -1) break
            const [job] = q.splice(idx, 1)
            job!.attempt++
            void run(job!)
          }
        }

        timer = setTimeout(loop, POLL_MS)
      }

      loop()
      const self = { stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
      consumers.push(self)

      return {
        // Sets the flag and returns. Never awaits active jobs.
        pause: async () => { paused = true },

        drain: async () => {
          while (active.size > 0) await new Promise(r => setTimeout(r, POLL_MS))
        },

        close: async (force) => {
          paused = true
          if (!force) {
            while (active.size > 0) await new Promise(r => setTimeout(r, POLL_MS))
          }
          self.stop()
        },

        activeCount: () => active.size,
        active: () => [...active.values()],
      }
    },

    depth: async (queue) => queueOf(queue).filter(j => j.runAt <= Date.now()).length,

    heartbeat: async (record, ttlMs) => {
      records.set(record.id, { record, expiresAt: record.lastHeartbeat + ttlMs })
    },

    deregister: async (id) => { records.delete(id) },

    workers: async () => {
      const now = Date.now()
      for (const [id, entry] of records) if (entry.expiresAt <= now) records.delete(id)
      return [...records.values()].map(e => e.record)
    },
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run test/unit/drivers/memory.test.ts`
Expected: PASS — 10 tests. The `pause` timing test is the one that matters most; if it fails, `pause()` is awaiting active work and the shutdown budget will be wrong.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/server/drivers/memory.ts test/unit/drivers/memory.test.ts
git commit -m "feat: add the in-memory driver with a real claim loop

Delays, retries and concurrency behave like the persistent driver so the
lifecycle tests exercise the same code paths. pause() sets a flag and
returns without awaiting active jobs, which the tests assert on timing."
```

---

### Task 6: `bullmq` driver

**Files:**
- Create: `src/runtime/server/drivers/bullmq.ts`
- Create: `test/unit/drivers/bullmq-mapping.test.ts`

**Interfaces:**
- Consumes: `ConciergeDriver`, `Consumer` (Task 4); envelope (Task 3).
- Produces: `createBullmqDriver(opts: CreateDriverOptions): ConciergeDriver` with `{ persistent: true, crossProcess: true }`.

This task's unit test covers only the pure mapping helpers, because everything else needs a live Redis. The real coverage is Task 12's lifecycle matrix.

- [ ] **Step 1: Write the failing test**

Create `test/unit/drivers/bullmq-mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildConnection, workerRecordKey, WORKER_KEY_PREFIX } from '../../../src/runtime/server/drivers/bullmq'

describe('bullmq connection mapping', () => {
  it('prefers a url when given', () => {
    expect(buildConnection({ url: 'redis://user:pw@example:6380' }))
      .toEqual({ url: 'redis://user:pw@example:6380' })
  })

  it('falls back to discrete fields', () => {
    expect(buildConnection({ host: 'h', port: 6379, password: 'p' }))
      .toEqual({ host: 'h', port: 6379, password: 'p' })
  })

  it('throws when neither is usable rather than silently connecting to localhost', () => {
    expect(() => buildConnection({})).toThrow(/connection/i)
  })
})

describe('worker record keys', () => {
  it('namespaces keys so they cannot collide with queue keys', () => {
    expect(workerRecordKey('abc')).toBe(`${WORKER_KEY_PREFIX}abc`)
    expect(WORKER_KEY_PREFIX).toMatch(/^concierge:workers:/)
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/drivers/bullmq-mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the bullmq driver**

Create `src/runtime/server/drivers/bullmq.ts`:

```ts
import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { decodePayload, encodePayload } from '../envelope'
import type { ActiveJob, JobHandler, WorkerRecord } from '../types'
import type { ConciergeDriver, Consumer } from './types'
import type { CreateDriverOptions } from './index'

export const WORKER_KEY_PREFIX = 'concierge:workers:'
export const workerRecordKey = (id: string) => `${WORKER_KEY_PREFIX}${id}`

export const buildConnection = (c: CreateDriverOptions['connection'] = {}) => {
  if (c.url) return { url: c.url }
  if (c.host) return { host: c.host, port: c.port ?? 6379, password: c.password }
  throw new Error(
    '[nuxt-concierge] the bullmq driver needs a connection. Set REDIS_URL or concierge.connection.',
  )
}

export const createBullmqDriver = (opts: CreateDriverOptions = {}): ConciergeDriver => {
  const connection = buildConnection(opts.connection)
  const bull = opts.bullmq ?? { maxStalledCount: 3, stalledInterval: 30_000 }

  const queues = new Map<string, Queue>()
  const handlers = new Map<string, JobHandler>()
  const workers: Worker[] = []
  let redis: Redis | undefined

  const key = (queue: string, name: string) => `${queue}::${name}`
  const client = () => {
    if (!redis) {
      redis = 'url' in connection && connection.url
        ? new Redis(connection.url, { maxRetriesPerRequest: null })
        : new Redis({ ...connection, maxRetriesPerRequest: null } as never)
    }
    return redis
  }

  const queueOf = (name: string) => {
    if (!queues.has(name)) {
      queues.set(name, new Queue(name, { connection: { ...connection } as never }))
    }
    return queues.get(name)!
  }

  return {
    name: 'bullmq',
    capabilities: { persistent: true, crossProcess: true },

    init: async () => { client() },

    close: async () => {
      await Promise.allSettled([
        ...[...queues.values()].map(q => q.close()),
        redis?.quit(),
      ])
      queues.clear()
      redis = undefined
    },

    registerHandler: (queue, name, handler) => { handlers.set(key(queue, name), handler) },

    enqueue: async (queue, job) => {
      const added = await queueOf(queue).add(job.name, encodePayload(job.payload), {
        delay: job.delay,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      })
      return { id: String(added.id) }
    },

    consume: (queue, consumeOpts, onJob): Consumer => {
      const active = new Map<string, ActiveJob>()

      const worker = new Worker(
        queue,
        async (job) => {
          const jobId = String(job.id)
          active.set(jobId, {
            jobId,
            queue,
            name: job.name,
            startedAt: job.processedOn ?? Date.now(),
          })
          try {
            const handler = onJob ?? handlers.get(key(queue, job.name))
            if (!handler) {
              throw new Error(`[nuxt-concierge] no handler for "${job.name}" on "${queue}"`)
            }
            await handler({
              id: jobId,
              name: job.name,
              queue,
              attempt: job.attemptsMade + 1,
              payload: decodePayload(job.data),
            })
          }
          finally {
            active.delete(jobId)
          }
        },
        {
          connection: { ...connection } as never,
          concurrency: consumeOpts.concurrency,
          // BullMQ defaults to 1, which fails a job permanently after two
          // force-closes. Too aggressive for long jobs plus frequent deploys.
          maxStalledCount: bull.maxStalledCount,
          stalledInterval: bull.stalledInterval,
        },
      )

      workers.push(worker)

      return {
        // worker.pause(true) does NOT wait for active jobs, unlike pause().
        pause: async () => { await worker.pause(true) },

        drain: async () => {
          while (active.size > 0) await new Promise(r => setTimeout(r, 25))
        },

        close: async (force) => { await worker.close(force) },

        activeCount: () => active.size,
        active: () => [...active.values()],
      }
    },

    depth: async (queue) => {
      const q = queueOf(queue)
      const [waiting, delayed] = await Promise.all([q.getWaitingCount(), q.getDelayedCount()])
      return waiting + delayed
    },

    heartbeat: async (record, ttlMs) => {
      await client().set(
        workerRecordKey(record.id),
        JSON.stringify(record),
        'PX',
        ttlMs,
      )
    },

    deregister: async (id) => { await client().del(workerRecordKey(id)) },

    workers: async () => {
      const found: WorkerRecord[] = []
      let cursor = '0'
      do {
        const [next, keys] = await client().scan(cursor, 'MATCH', `${WORKER_KEY_PREFIX}*`, 'COUNT', 100)
        cursor = next
        if (keys.length) {
          const values = await client().mget(...keys)
          for (const v of values) {
            if (v) {
              try { found.push(JSON.parse(v) as WorkerRecord) }
              catch { /* a malformed record must not break the whole listing */ }
            }
          }
        }
      } while (cursor !== '0')
      return found
    },
  }
}
```

Redis key expiry (`PX`) gives registry TTL for free, so `workers()` needs no filtering — unlike the memory driver, which filters on read. `SCAN` rather than `KEYS` because `KEYS` blocks the Redis event loop.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run test/unit/drivers/bullmq-mapping.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify the whole unit suite still passes**

Run: `pnpm vitest run test/unit`
Expected: PASS — all tests from Tasks 2–6.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/server/drivers/bullmq.ts test/unit/drivers/bullmq-mapping.test.ts
git commit -m "feat: add the bullmq driver

pause() maps to worker.pause(true), which returns without awaiting active
jobs. maxStalledCount defaults to 3 rather than BullMQ's 1, which would fail
a job permanently after two force-closes. Worker records use Redis key expiry
for registry TTL and SCAN rather than KEYS to avoid blocking the server."
```

---

### Task 7: `defineJob`, job scanning, and `useQueue().enqueue`

**Files:**
- Create: `src/runtime/server/handlers/defineJob.ts`
- Create: `src/runtime/server/utils/useQueue.ts`
- Create: `src/scan.ts`
- Create: `test/unit/defineJob.test.ts`
- Delete: `src/helplers/scan-folder.ts`, `src/helplers/index.ts`
- Modify: `src/module.ts`, `src/templates.ts`

**Interfaces:**
- Consumes: `JobDefinition`, `JobHandler` (Task 2); `ConciergeDriver` (Task 4).
- Produces:
  - `defineJob(opts: { name?: string; queue?: string; handler: JobHandler }): JobDefinition`
  - `scanJobs(): Promise<string[]>` — absolute paths under `<rootDir>/server/jobs`
  - `useQueue(): { enqueue(name, payload, opts?): Promise<{ id: string }> }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/defineJob.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'

describe('defineJob', () => {
  it('keeps an explicit name and queue', () => {
    const job = defineJob({ name: 'send-email', queue: 'mail', handler: async () => {} })
    expect(job.name).toBe('send-email')
    expect(job.queue).toBe('mail')
  })

  it('defaults the queue to "default"', () => {
    expect(defineJob({ name: 'j', handler: async () => {} }).queue).toBe('default')
  })

  it('leaves the name empty when omitted so the build can infer it from the filename', () => {
    expect(defineJob({ handler: async () => {} }).name).toBe('')
  })

  it('throws when no handler is supplied', () => {
    // @ts-expect-error deliberately invalid
    expect(() => defineJob({ name: 'j' })).toThrow(/handler/)
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/defineJob.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `defineJob`**

Create `src/runtime/server/handlers/defineJob.ts`:

```ts
import type { JobDefinition, JobHandler } from '../types'

export interface DefineJobOptions {
  /** Defaults to the filename, resolved at build time. */
  name?: string
  /** Must exist in concierge.worker.queues or the build fails. */
  queue?: string
  handler: JobHandler
}

/**
 * Phase 1 shape: untyped payload, no codegen. Spec 3 adds the generated
 * name -> payload map and makes enqueue generic over it.
 */
export const defineJob = (opts: DefineJobOptions): JobDefinition => {
  if (typeof opts?.handler !== 'function') {
    throw new Error('[nuxt-concierge] defineJob requires a handler function')
  }

  return {
    name: opts.name ?? '',
    queue: opts.queue ?? 'default',
    handler: opts.handler,
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run test/unit/defineJob.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Implement scanning against `rootDir`**

Create `src/scan.ts`:

```ts
import { basename } from 'node:path'
import fg from 'fast-glob'
import { useNuxt } from '@nuxt/kit'

export const JOBS_DIR = 'server/jobs'

/**
 * Scans <rootDir>/server/jobs.
 *
 * rootDir, NOT srcDir: in Nuxt 4 srcDir defaults to `app/`, so resolving
 * against it yields `app/server/jobs`, which does not exist — the scan finds
 * nothing and no error is raised. server/ lives at rootDir in both v3 and v4.
 * Credit: PR #10 by @gsxdsm.
 */
export const scanJobs = async (): Promise<string[]> => {
  const nuxt = useNuxt()
  const cwd = `${nuxt.options.rootDir}/${JOBS_DIR}`

  const files = await fg('**/*.{ts,js,mjs}', { cwd, absolute: true, onlyFiles: true })
  return [...new Set(files)].sort()
}

/** `server/jobs/send-email.ts` -> `send-email` */
export const jobNameFromPath = (path: string): string =>
  basename(path).replace(/\.(ts|js|mjs)$/, '')
```

- [ ] **Step 6: Delete the old scanner**

```bash
git rm src/helplers/scan-folder.ts src/helplers/index.ts
```

Then remove `import { scanFolder } from "./helplers"` from `src/module.ts` and replace its three `scanFolder(...)` calls with a single `await scanJobs()`.

- [ ] **Step 7: Implement `useQueue`**

Create `src/runtime/server/utils/useQueue.ts`:

```ts
import { getDriver } from '../supervisor'

export interface EnqueueJobOptions {
  delay?: number
  queue?: string
}

/**
 * Enqueue from anywhere in server/. Phase 1 takes an untyped payload and a
 * string name; spec 3 generates a name -> payload map and makes this generic.
 */
export const useQueue = () => ({
  enqueue: async (name: string, payload: unknown, opts: EnqueueJobOptions = {}) => {
    const { driver, routes } = getDriver()
    const queue = opts.queue ?? routes.get(name)

    if (!queue) {
      throw new Error(
        `[nuxt-concierge] no job named "${name}" is registered. `
        + `Create server/jobs/${name}.ts, or pass an explicit queue.`,
      )
    }

    return driver.enqueue(queue, { name, payload, delay: opts.delay })
  },
})
```

`getDriver()` is created in Task 8. The `routes` map means the enqueue path needs only a name → queue lookup, never the handler module.

- [ ] **Step 8: Verify and commit**

```bash
pnpm dev:prepare && pnpm lint && pnpm test
git add src/runtime/server/handlers/defineJob.ts src/runtime/server/utils/useQueue.ts src/scan.ts test/unit/defineJob.test.ts src/module.ts
git commit -m "feat: add defineJob, job scanning and useQueue().enqueue

Scans <rootDir>/server/jobs. rootDir rather than srcDir: Nuxt 4 defaults
srcDir to app/, which makes the scan silently find nothing. Credit PR #10
by @gsxdsm.

Enqueue resolves a name -> queue route without importing the handler, so the
web process never pulls handler code into its bundle."
```

---

### Task 8: Supervisor and heartbeat

**Files:**
- Create: `src/runtime/server/supervisor.ts`
- Create: `test/unit/supervisor.test.ts`
- Modify: `src/templates.ts`
- Delete: `src/runtime/server/utils/concierge.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces:
  - `createSupervisor(config): Promise<Supervisor>`
  - `interface Supervisor { getState(); setState(); startConsumers(); consumers; driver; routes; record(); stop() }`
  - `getDriver(): { driver: ConciergeDriver; routes: Map<string, string> }`
  - `getSupervisor(): Supervisor | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/unit/supervisor.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSupervisor, resetSupervisor } from '../../src/runtime/server/supervisor'

const baseConfig = {
  role: 'both' as const,
  driver: 'memory' as const,
  connection: {},
  bullmq: { maxStalledCount: 3, stalledInterval: 30_000 },
  worker: {
    queues: { default: 2 },
    shutdownTimeout: 20_000,
    heartbeatInterval: 5_000,
    heartbeatTtl: 15_000,
  },
  jobs: [{ name: 'work', queue: 'default', handler: async () => {} }],
  version: 'test-1',
}

afterEach(() => { resetSupervisor() })

describe('supervisor', () => {
  it('starts in "starting" and reaches "running" after consumers start', async () => {
    const s = await createSupervisor(baseConfig)
    expect(s.getState()).toBe('starting')

    await s.startConsumers()
    expect(s.getState()).toBe('running')

    await s.stop()
  })

  it('starts one consumer per configured queue under role: worker', async () => {
    const s = await createSupervisor({
      ...baseConfig,
      role: 'worker',
      worker: { ...baseConfig.worker, queues: { default: 1, mail: 1 } },
      jobs: [
        { name: 'work', queue: 'default', handler: async () => {} },
        { name: 'send', queue: 'mail', handler: async () => {} },
      ],
    })
    await s.startConsumers()

    expect(s.consumers.size).toBe(2)
    await s.stop()
  })

  it('starts no consumers under role: web but still exists', async () => {
    const s = await createSupervisor({ ...baseConfig, role: 'web' })
    await s.startConsumers()

    expect(s.consumers.size).toBe(0)
    expect(s.getState()).toBe('running')
    await s.stop()
  })

  it('throws when a job names a queue absent from the concurrency map', async () => {
    await expect(createSupervisor({
      ...baseConfig,
      jobs: [{ name: 'orphan', queue: 'nope', handler: async () => {} }],
    })).rejects.toThrow(/"nope".*worker\.queues/)
  })

  it('builds a route map from name to queue', async () => {
    const s = await createSupervisor(baseConfig)
    expect(s.routes.get('work')).toBe('default')
    await s.stop()
  })

  it('produces a worker record that snapshots active jobs', async () => {
    const s = await createSupervisor(baseConfig)
    await s.startConsumers()

    const record = s.record()
    expect(record.role).toBe('both')
    expect(record.queues).toEqual(['default'])
    expect(record.concurrency).toEqual({ default: 2 })
    expect(record.version).toBe('test-1')
    expect(record.state).toBe('running')
    expect(Array.isArray(record.active)).toBe(true)

    await s.stop()
  })

  it('writes heartbeats on an interval and deregisters on stop', async () => {
    vi.useFakeTimers()
    const s = await createSupervisor({
      ...baseConfig,
      worker: { ...baseConfig.worker, heartbeatInterval: 1000 },
    })
    const beat = vi.spyOn(s.driver, 'heartbeat')
    const gone = vi.spyOn(s.driver, 'deregister')

    await s.startConsumers()
    await vi.advanceTimersByTimeAsync(3500)
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(3)

    vi.useRealTimers()
    await s.stop()
    expect(gone).toHaveBeenCalledWith(s.id)
  })

  it('reports state "draining" in the record once draining', async () => {
    const s = await createSupervisor(baseConfig)
    await s.startConsumers()
    s.setState('draining')

    expect(s.record().state).toBe('draining')
    await s.stop()
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/supervisor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the supervisor**

Create `src/runtime/server/supervisor.ts`:

```ts
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { consola } from 'consola'
import { createDriver, resolveDriverName } from './drivers'
import type { ConciergeDriver, Consumer } from './drivers'
import type { JobDefinition, Role, SupervisorState, WorkerRecord } from './types'

const logger = consola.create({}).withTag('nuxt-concierge')

export interface SupervisorConfig {
  role: Role
  driver: 'auto' | 'sync' | 'memory' | 'bullmq'
  connection: { url?: string, host?: string, port?: number, password?: string }
  bullmq: { maxStalledCount: number, stalledInterval: number }
  worker: {
    queues: Record<string, number>
    shutdownTimeout: number
    heartbeatInterval: number
    heartbeatTtl: number
  }
  jobs: JobDefinition[]
  version: string
}

export interface Supervisor {
  readonly id: string
  readonly driver: ConciergeDriver
  readonly routes: Map<string, string>
  readonly consumers: Map<string, Consumer>
  readonly config: SupervisorConfig
  getState: () => SupervisorState
  setState: (state: SupervisorState) => void
  startConsumers: () => Promise<void>
  record: () => WorkerRecord
  stop: () => Promise<void>
}

let current: Supervisor | undefined

export const getSupervisor = (): Supervisor | undefined => current
export const resetSupervisor = () => { current = undefined }

export const getDriver = () => {
  if (!current) throw new Error('[nuxt-concierge] the supervisor has not started yet')
  return { driver: current.driver, routes: current.routes }
}

export const createSupervisor = async (config: SupervisorConfig): Promise<Supervisor> => {
  const queueNames = Object.keys(config.worker.queues)

  // A job naming an undeclared queue is a boot error, not a silently orphaned
  // job that never runs and never reports why.
  for (const job of config.jobs) {
    if (!queueNames.includes(job.queue)) {
      throw new Error(
        `[nuxt-concierge] job "${job.name}" targets queue "${job.queue}", which is not declared in `
        + `concierge.worker.queues (declared: ${queueNames.join(', ') || 'none'}).`,
      )
    }
  }

  const driverName = resolveDriverName({
    configured: config.driver,
    hasConnection: Boolean(config.connection.url ?? config.connection.host),
    isProduction: process.env.NODE_ENV === 'production',
  })

  const driver = await createDriver(driverName, {
    connection: config.connection,
    bullmq: config.bullmq,
  })
  await driver.init()

  for (const job of config.jobs) driver.registerHandler(job.queue, job.name, job.handler)

  const routes = new Map(config.jobs.map(j => [j.name, j.queue]))
  const consumers = new Map<string, Consumer>()
  const id = randomUUID().slice(0, 8)
  const startedAt = Date.now()

  let state: SupervisorState = 'starting'
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  const supervisor: Supervisor = {
    id,
    driver,
    routes,
    consumers,
    config,

    getState: () => state,
    setState: (next) => { state = next },

    record: () => ({
      id,
      hostname: hostname(),
      pid: process.pid,
      role: config.role === 'web' ? 'both' : config.role,
      queues: queueNames,
      concurrency: config.worker.queues,
      version: config.version,
      startedAt,
      lastHeartbeat: Date.now(),
      state: state === 'draining' ? 'draining' : 'running',
      // Snapshotted here rather than written per job transition: doing it on
      // start/finish would add two registry writes per job to the hot path.
      active: [...consumers.values()].flatMap(c => c.active()),
    }),

    startConsumers: async () => {
      if (config.role !== 'web') {
        for (const [queue, concurrency] of Object.entries(config.worker.queues)) {
          consumers.set(queue, driver.consume(queue, { concurrency }))
        }

        heartbeatTimer = setInterval(() => {
          void driver.heartbeat(supervisor.record(), config.worker.heartbeatTtl)
            .catch(error => logger.debug('heartbeat failed', error))
        }, config.worker.heartbeatInterval)

        // Beat once immediately so a worker is visible before the first interval.
        await driver.heartbeat(supervisor.record(), config.worker.heartbeatTtl).catch(() => {})
      }

      state = 'running'
    },

    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      await Promise.allSettled([...consumers.values()].map(c => c.close(true)))
      consumers.clear()
      await driver.deregister(id).catch(() => {})
      await driver.close(true).catch(() => {})
      state = 'stopped'
      if (current === supervisor) current = undefined
    },
  }

  current = supervisor
  return supervisor
}
```

`stop()` is the blunt teardown used by tests and the double-signal path. Task 9 adds the graceful drain, which is a different sequence.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run test/unit/supervisor.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Rewrite the generated nitro plugin**

Replace `createTemplateNuxtPlugin` in `src/templates.ts` with:

```ts
export const createTemplateNuxtPlugin = (jobFiles: string[], jobNames: string[]) => {
  const imports = jobFiles
    .map((file, i) => `import job${i} from '${file.replace(/\.ts$/, '')}'`)
    .join('\n')

  const registrations = jobFiles
    .map((_f, i) => `  { ...job${i}, name: job${i}.name || ${JSON.stringify(jobNames[i])} },`)
    .join('\n')

  // IMPORTANT: this template is emitted as `0.concierge-nuxt-plugin.ts`.
  // The `0.` prefix is load-bearing, not cosmetic — nitro close hooks run in
  // registration order, so concierge must register FIRST to drain jobs before
  // a DB-pool plugin tears down connections under a running handler.
  // Do NOT import defineNitroPlugin from "#imports": it is auto-imported, and
  // the explicit import breaks resolution (notably with Prisma).
  return `
${imports}
import { useRuntimeConfig } from '#imports'
import { resolveRole, resolveVersion } from '#concierge/role'
import { createSupervisor } from '#concierge/supervisor'
import { installShutdown } from '#concierge/shutdown'
import { checkGuardrails } from '#concierge/guardrails'

const jobs = [
${registrations}
]

export default defineNitroPlugin(async (nitroApp) => {
  const config = useRuntimeConfig().concierge

  // Re-resolve from env at boot: the build artifact is shared across processes
  // but CONCIERGE_ROLE differs per process, so the baked-in value is only a
  // default.
  const role = resolveRole({
    env: process.env.CONCIERGE_ROLE,
    config: config.role,
    isDev: import.meta.dev,
  })

  const version = resolveVersion({
    env: process.env.CONCIERGE_VERSION,
    packageVersion: config.version,
  })

  const supervisor = await createSupervisor({ ...config, role, jobs, version })

  checkGuardrails({
    role,
    capabilities: supervisor.driver.capabilities,
    driverName: supervisor.driver.name,
    queueCount: Object.keys(config.worker.queues).length,
    isProduction: process.env.NODE_ENV === 'production',
    shutdownTimeout: config.worker.shutdownTimeout,
    nitroShutdownTimeout: Number(process.env.NITRO_SHUTDOWN_TIMEOUT) || 30000,
    nitroShutdownDisabled: Boolean(process.env.NITRO_SHUTDOWN_DISABLED),
    preset: import.meta.env?.NITRO_PRESET,
  })

  await supervisor.startConsumers()
  installShutdown(nitroApp, supervisor)
})
`
}
```

Then in `createTemplateType`, add aliases for the new modules alongside the existing ones:

```ts
nitroConfig.alias['#concierge/role'] = resolve('./runtime/server/role')
nitroConfig.alias['#concierge/supervisor'] = resolve('./runtime/server/supervisor')
nitroConfig.alias['#concierge/shutdown'] = resolve('./runtime/server/shutdown')
nitroConfig.alias['#concierge/guardrails'] = resolve('./runtime/server/guardrails')
```

Replace the `#concierge-handlers` type template body with just `defineJob`, and delete the `$useConcierge` declaration.

- [ ] **Step 6: Delete the v1 runtime**

```bash
git rm src/runtime/server/utils/concierge.ts
```

- [ ] **Step 7: Add stubs for the modules Tasks 9 and 11 will implement**

The generated plugin imports `#concierge/shutdown` and `#concierge/guardrails`, which do not exist yet. Create them as stubs so the build never breaks — Tasks 9 and 11 replace their contents entirely.

Create `src/runtime/server/shutdown.ts`:

```ts
// Stub — Task 9 replaces this file with the bounded drain sequence.
import type { Supervisor } from './supervisor'

export interface NitroAppLike {
  hooks: { hookOnce: (name: string, fn: () => Promise<void> | void) => void }
}

export const installShutdown = (_nitroApp: NitroAppLike, _supervisor: Supervisor): void => {}
```

Create `src/runtime/server/guardrails.ts`:

```ts
// Stub — Task 11 replaces this file with the real boot checks.
export interface GuardrailInput {
  role: string
  capabilities: { persistent: boolean, crossProcess: boolean }
  driverName: string
  queueCount: number
  isProduction: boolean
  shutdownTimeout: number
  nitroShutdownTimeout: number
  nitroShutdownDisabled: boolean
  preset?: string
}

export const checkGuardrails = (_input: GuardrailInput): void => {}
```

- [ ] **Step 8: Verify the build is green**

```bash
pnpm dev:prepare && pnpm lint && pnpm test && pnpm prepack
```

Expected: all pass. If `dev:prepare` fails on a missing `#concierge/*` alias, re-check the alias block from Step 5.

- [ ] **Step 9: Commit**

```bash
git add src/runtime/server/supervisor.ts src/runtime/server/shutdown.ts src/runtime/server/guardrails.ts test/unit/supervisor.test.ts src/templates.ts
git commit -m "feat: add the worker supervisor and heartbeat loop

One object owns worker lifecycle, the state machine and heartbeats. Active
jobs are snapshotted by the heartbeat rather than written per transition,
keeping two registry writes per job off the hot path.

A job targeting an undeclared queue is now a boot error rather than a job
that silently never runs.

The generated plugin keeps its 0. prefix, now with a comment explaining that
close-hook ordering depends on it, and no longer imports defineNitroPlugin
from #imports.

shutdown.ts and guardrails.ts land as stubs so the build stays green; Tasks 9
and 11 replace them."
```

---

### Task 9: Graceful shutdown

The core of phase 1.

**Files:**
- Replace: `src/runtime/server/shutdown.ts` (Task 8 left a stub; overwrite it entirely)
- Create: `test/unit/shutdown.test.ts`

**Interfaces:**
- Consumes: `Supervisor` (Task 8), `Consumer` (Task 4).
- Produces:
  - `installShutdown(nitroApp, supervisor): void`
  - `runDrain(supervisor, opts): Promise<DrainOutcome>`
  - `interface DrainOutcome { forced: boolean; abandoned: ActiveJob[]; deregistered: boolean }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/shutdown.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { runDrain } from '../../src/runtime/server/shutdown'
import type { ActiveJob } from '../../src/runtime/server/types'

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

const fakeConsumer = (opts: {
  drainMs?: number
  pauseMs?: number
  active?: ActiveJob[]
  clearActiveOnForce?: boolean
} = {}) => {
  let active = opts.active ?? []
  return {
    pause: vi.fn(async () => { if (opts.pauseMs) await tick(opts.pauseMs) }),
    drain: vi.fn(async () => { await tick(opts.drainMs ?? 0) }),
    close: vi.fn(async (force: boolean) => { if (force && opts.clearActiveOnForce) active = [] }),
    activeCount: () => active.length,
    active: () => active,
  }
}

const fakeSupervisor = (consumers: ReturnType<typeof fakeConsumer>[]) => ({
  id: 'w1',
  consumers: new Map(consumers.map((c, i) => [`q${i}`, c])),
  driver: { deregister: vi.fn(async () => {}), close: vi.fn(async () => {}) },
  setState: vi.fn(),
  getState: vi.fn(() => 'draining' as const),
})

describe('runDrain', () => {
  it('pauses every consumer before draining', async () => {
    const c = fakeConsumer()
    const s = fakeSupervisor([c])

    await runDrain(s as never, { timeout: 1000 })

    expect(c.pause).toHaveBeenCalled()
    expect(c.pause.mock.invocationCallOrder[0]!)
      .toBeLessThan(c.drain.mock.invocationCallOrder[0]!)
  })

  it('closes cleanly with force=false when the drain finishes in budget', async () => {
    const c = fakeConsumer({ drainMs: 10 })
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 500 })

    expect(outcome.forced).toBe(false)
    expect(c.close).toHaveBeenCalledWith(false)
    expect(outcome.abandoned).toEqual([])
  })

  it('force-closes when the drain exceeds the budget', async () => {
    const c = fakeConsumer({ drainMs: 500 })
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 80 })

    expect(outcome.forced).toBe(true)
    expect(c.close).toHaveBeenCalledWith(true)
  })

  it('snapshots abandoned job IDs BEFORE force close', async () => {
    // close(true) can clear local active tracking, so reading active() after
    // forcing would report nothing and the IDs would be unrecoverable.
    const active: ActiveJob[] = [{ jobId: 'j-77', queue: 'q0', name: 'slow', startedAt: 1 }]
    const c = fakeConsumer({ drainMs: 500, active, clearActiveOnForce: true })
    const s = fakeSupervisor([c])

    const outcome = await runDrain(s as never, { timeout: 60 })

    expect(outcome.abandoned.map(j => j.jobId)).toEqual(['j-77'])
  })

  it('deregisters and closes the driver on the clean path', async () => {
    const s = fakeSupervisor([fakeConsumer({ drainMs: 5 })])

    const outcome = await runDrain(s as never, { timeout: 500 })

    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
    expect(s.driver.close).toHaveBeenCalled()
    expect(outcome.deregistered).toBe(true)
  })

  it('deregisters even on the forced path', async () => {
    const s = fakeSupervisor([fakeConsumer({ drainMs: 500 })])

    await runDrain(s as never, { timeout: 50 })

    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
  })

  it('deregisters even when pause throws', async () => {
    const c = fakeConsumer()
    c.pause = vi.fn(async () => { throw new Error('pause exploded') })
    const s = fakeSupervisor([c])

    await runDrain(s as never, { timeout: 200 })

    expect(s.driver.deregister).toHaveBeenCalledWith('w1')
  })

  it('a slow pause cannot consume the whole budget', async () => {
    // The deadline is computed once at entry and shared by every step, so a
    // slow pause() leaves no time for drain but still leaves the finally block
    // reachable.
    const c = fakeConsumer({ pauseMs: 200, drainMs: 5000 })
    const s = fakeSupervisor([c])

    const started = Date.now()
    const outcome = await runDrain(s as never, { timeout: 250 })
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(1000)
    expect(outcome.forced).toBe(true)
    expect(s.driver.deregister).toHaveBeenCalled()
  })

  it('sets state to draining at entry', async () => {
    const s = fakeSupervisor([fakeConsumer()])
    await runDrain(s as never, { timeout: 200 })
    expect(s.setState).toHaveBeenCalledWith('draining')
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/shutdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement shutdown**

Create `src/runtime/server/shutdown.ts`:

```ts
import { consola } from 'consola'
import type { Supervisor } from './supervisor'
import type { ActiveJob } from './types'

const logger = consola.create({}).withTag('nuxt-concierge')

export interface DrainOptions {
  timeout: number
}

export interface DrainOutcome {
  forced: boolean
  abandoned: ActiveJob[]
  deregistered: boolean
}

const withDeadline = async <T>(promise: Promise<T>, ms: number): Promise<{ timedOut: boolean }> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms))
  })

  try {
    const result = await Promise.race([promise.then(() => 'done' as const), timeout])
    return { timedOut: result === 'timeout' }
  }
  finally {
    clearTimeout(timer!)
  }
}

/**
 * The whole sequence shares ONE deadline computed at entry — not just the drain
 * step. pause(), consumer close, driver close and deregistration can each block
 * or reject, and an unbounded shutdown is SIGKILLed by the platform, which
 * loses the clean path entirely.
 */
export const runDrain = async (
  supervisor: Supervisor,
  { timeout }: DrainOptions,
): Promise<DrainOutcome> => {
  const deadline = Date.now() + timeout
  const remaining = () => deadline - Date.now()

  supervisor.setState('draining')

  const consumers = [...supervisor.consumers.values()]
  let forced = false
  let abandoned: ActiveJob[] = []

  try {
    // 1. Stop fetching. Must not await active jobs (see Consumer.pause).
    await withDeadline(
      Promise.allSettled(consumers.map(c => c.pause())).then(() => undefined),
      remaining(),
    )

    // 2. Wait for in-flight to reach zero, bounded by what is left.
    const drained = await withDeadline(
      Promise.all(consumers.map(c => c.drain())).then(() => undefined),
      remaining(),
    )

    if (drained.timedOut) {
      forced = true
      // 3. Snapshot BEFORE forcing: close(true) can clear active tracking.
      abandoned = consumers.flatMap(c => c.active())
      await Promise.allSettled(consumers.map(c => c.close(true)))

      logger.warn(
        `Shutdown exceeded ${timeout}ms; force-closed with ${abandoned.length} job(s) in flight. `
        + `These are eligible for redelivery: ${abandoned.map(j => j.jobId).join(', ') || 'none'}`,
      )
    }
    else {
      // 4. Clean path.
      await Promise.allSettled(consumers.map(c => c.close(false)))
      logger.info('Workers drained cleanly')
    }
  }
  catch (error) {
    forced = true
    logger.error('Drain failed', error)
  }
  finally {
    // 5. Always deregister and close the driver, on every path.
    await withDeadline(
      supervisor.driver.deregister(supervisor.id).catch(() => {}),
      Math.max(remaining(), 1000),
    )
    await withDeadline(
      supervisor.driver.close(forced).catch(() => {}),
      Math.max(remaining(), 1000),
    )
    supervisor.setState('stopped')
  }

  return { forced, abandoned, deregistered: true }
}

export interface NitroAppLike {
  hooks: { hookOnce: (name: string, fn: () => Promise<void> | void) => void }
}

export const installShutdown = (nitroApp: NitroAppLike, supervisor: Supervisor): void => {
  let signalled = false

  const onSignal = () => {
    if (signalled) {
      // Nitro's own handler uses a once-factory and ignores repeat signals, so
      // the double-signal escape hatch has to be ours.
      logger.warn('Second signal received; exiting immediately')
      process.exit(1)
    }
    signalled = true
    // Synchronous and immediate: flips readiness to 503 while the HTTP
    // listener is still up. The actual drain happens in the close hook.
    supervisor.setState('draining')
  }

  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  // Nitro awaits this. It fires AFTER Nitro has drained HTTP connections,
  // which is why role: worker refuses application routes — a worker with no
  // long-lived connections reaches this almost immediately.
  nitroApp.hooks.hookOnce('close', async () => {
    await runDrain(supervisor, { timeout: supervisor.config.worker.shutdownTimeout })
  })
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run test/unit/shutdown.test.ts`
Expected: PASS — 9 tests. The snapshot-before-force test and the slow-pause test are the two that encode the non-obvious requirements.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/server/shutdown.ts test/unit/shutdown.test.ts
git commit -m "feat: add bounded graceful shutdown

One deadline computed at entry bounds the whole sequence, not just drain, so
a slow pause() cannot leave the finally block unreachable. Abandoned job IDs
are snapshotted before force close, which can clear active tracking.

Our signal listener only flips state to draining, synchronously; the drain
runs in Nitro's awaited close hook. We also own the double-signal exit,
because Nitro's handler ignores repeat signals."
```

---

### Task 10: Health endpoint and role-based route gating

**Files:**
- Create: `src/runtime/server/routes/health.ts`
- Create: `src/runtime/server/middleware/role-gate.ts`
- Create: `test/unit/health.test.ts`
- Modify: `src/module.ts`

**Interfaces:**
- Consumes: `getSupervisor()` (Task 8).
- Produces: `GET /_concierge/health`; `healthPayload(supervisor)`; server middleware gating non-health routes under `role: worker`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { healthPayload, healthStatus } from '../../src/runtime/server/routes/health'

const supervisorAt = (state: string) => ({
  getState: () => state,
  config: { role: 'worker', worker: { queues: { default: 5 } }, version: 'v1' },
  consumers: new Map([['default', { activeCount: () => 2, active: () => [] }]]),
})

describe('health endpoint', () => {
  it('returns 200 only when running', () => {
    expect(healthStatus('running')).toBe(200)
  })

  it('returns 503 while starting, so readiness is false until consumers are up', () => {
    // Binding the HTTP listener is not readiness. A rolling deploy must not
    // route traffic to a process whose consumers have not started.
    expect(healthStatus('starting')).toBe(503)
  })

  it('returns 503 while draining and once stopped', () => {
    expect(healthStatus('draining')).toBe(503)
    expect(healthStatus('stopped')).toBe(503)
  })

  it('returns 503 when there is no supervisor at all', () => {
    expect(healthStatus(undefined)).toBe(503)
  })

  it('reports state, role, queues, activeCount and version', () => {
    expect(healthPayload(supervisorAt('running') as never)).toEqual({
      state: 'running',
      role: 'worker',
      queues: ['default'],
      activeCount: 2,
      version: 'v1',
    })
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the health route**

Create `src/runtime/server/routes/health.ts`:

```ts
import { defineEventHandler, setResponseStatus } from 'h3'
import { getSupervisor } from '../supervisor'
import type { Supervisor } from '../supervisor'
import type { SupervisorState } from '../types'

/**
 * 200 only in `running`. Readiness must stay false until consumers are
 * actually up — binding the listener is not readiness.
 */
export const healthStatus = (state: SupervisorState | undefined): 200 | 503 =>
  state === 'running' ? 200 : 503

export const healthPayload = (supervisor: Supervisor) => ({
  state: supervisor.getState(),
  role: supervisor.config.role,
  queues: Object.keys(supervisor.config.worker.queues),
  activeCount: [...supervisor.consumers.values()].reduce((n, c) => n + c.activeCount(), 0),
  version: supervisor.config.version,
})

export default defineEventHandler((event) => {
  const supervisor = getSupervisor()
  const status = healthStatus(supervisor?.getState())
  setResponseStatus(event, status)

  if (!supervisor) return { state: 'stopped', error: 'supervisor not started' }
  return healthPayload(supervisor)
})
```

- [ ] **Step 4: Implement the role gate**

Create `src/runtime/server/middleware/role-gate.ts`:

```ts
import { defineEventHandler, setResponseStatus } from 'h3'
import { getSupervisor } from '../supervisor'

const ALLOWED_PREFIX = '/_concierge/health'

/**
 * Under role: worker, serve only the health route.
 *
 * Two reasons. It makes the process's job unambiguous, so a misconfigured load
 * balancer cannot send real traffic to a worker. And it is load-bearing for the
 * drain: Nitro closes HTTP connections and waits for them BEFORE calling close
 * hooks, so a worker with no long-lived connections reaches the drain in about
 * one poll interval instead of being starved by an open stream.
 */
export default defineEventHandler((event) => {
  const supervisor = getSupervisor()
  if (supervisor?.config.role !== 'worker') return
  if (event.path?.startsWith(ALLOWED_PREFIX)) return

  setResponseStatus(event, 503)
  return { error: 'This process runs with CONCIERGE_ROLE=worker and does not serve application routes.' }
})
```

- [ ] **Step 5: Register both in the module**

In `src/module.ts`, add alongside the existing `addServerHandler` calls:

```ts
addServerHandler({
  route: '/_concierge/health',
  handler: resolve('./runtime/server/routes/health'),
})

addServerHandler({
  middleware: true,
  handler: resolve('./runtime/server/middleware/role-gate'),
})
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `pnpm vitest run test/unit/health.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/routes/health.ts src/runtime/server/middleware/role-gate.ts test/unit/health.test.ts src/module.ts
git commit -m "feat: add the health endpoint and role-based route gating

Health returns 200 only in running; starting, draining and stopped all 503,
so a rolling deploy cannot route traffic to a process whose consumers are not
up yet.

Under role: worker only the health route is served. Besides making the
process's job unambiguous, this is load-bearing for the drain: Nitro waits
for HTTP connections to close before calling close hooks, so a worker with no
long-lived connections is not starved of its shutdown budget."
```

---

### Task 11: Boot guardrails and the no-worker warning

**Files:**
- Replace: `src/runtime/server/guardrails.ts` (Task 8 left a stub; overwrite it entirely)
- Create: `test/unit/guardrails.test.ts`
- Modify: `src/runtime/server/supervisor.ts`

**Interfaces:**
- Consumes: `DriverCapabilities` (Task 4), `Role` (Task 2).
- Produces:
  - `checkGuardrails(input): void` — throws on rule 1, warns otherwise
  - `startNoWorkerWatch(supervisor): () => void`

- [ ] **Step 1: Write the failing test**

Create `test/unit/guardrails.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkGuardrails, guardrailDiagnostics } from '../../src/runtime/server/guardrails'

const base = {
  role: 'both' as const,
  capabilities: { persistent: true, crossProcess: true },
  driverName: 'bullmq',
  queueCount: 1,
  isProduction: false,
  shutdownTimeout: 20_000,
  nitroShutdownTimeout: 30_000,
  nitroShutdownDisabled: false,
  preset: 'node-server',
}

describe('guardrails', () => {
  it('passes a sane configuration', () => {
    expect(guardrailDiagnostics(base)).toEqual([])
  })

  it('throws for a non-crossProcess driver outside role: both', () => {
    // Derived from capability, not driver name, so it covers memory+worker and
    // sync+worker with one rule and any future driver for free.
    expect(() => checkGuardrails({
      ...base,
      role: 'worker',
      driverName: 'memory',
      capabilities: { persistent: false, crossProcess: false },
    })).toThrow(/memory.*cannot be used with role "worker"/)
  })

  it('allows a non-crossProcess driver under role: both', () => {
    expect(() => checkGuardrails({
      ...base,
      role: 'both',
      driverName: 'memory',
      capabilities: { persistent: false, crossProcess: false },
    })).not.toThrow()
  })

  it('warns but does not throw for a non-persistent driver in production', () => {
    const d = guardrailDiagnostics({
      ...base,
      isProduction: true,
      capabilities: { persistent: false, crossProcess: true },
    })
    expect(d.some(x => x.level === 'warn' && /persist/i.test(x.message))).toBe(true)
    expect(d.some(x => x.level === 'error')).toBe(false)
  })

  it('warns when a worker has no queues configured', () => {
    const d = guardrailDiagnostics({ ...base, role: 'worker', queueCount: 0 })
    expect(d.some(x => /no queues/i.test(x.message))).toBe(true)
  })

  it('warns when shutdownTimeout is not below NITRO_SHUTDOWN_TIMEOUT', () => {
    const d = guardrailDiagnostics({ ...base, shutdownTimeout: 30_000, nitroShutdownTimeout: 30_000 })
    expect(d.some(x => /NITRO_SHUTDOWN_TIMEOUT/.test(x.message))).toBe(true)
  })

  it('warns loudly when NITRO_SHUTDOWN_DISABLED is set', () => {
    // Close hooks never fire, so the drain silently never runs and every
    // deploy drops in-flight jobs.
    const d = guardrailDiagnostics({ ...base, nitroShutdownDisabled: true })
    expect(d.some(x => /NITRO_SHUTDOWN_DISABLED/.test(x.message))).toBe(true)
  })

  it('warns on a serverless preset with a non-persistent driver', () => {
    const d = guardrailDiagnostics({
      ...base,
      preset: 'vercel',
      capabilities: { persistent: false, crossProcess: true },
    })
    expect(d.some(x => /serverless/i.test(x.message))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run test/unit/guardrails.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement guardrails**

Create `src/runtime/server/guardrails.ts`:

```ts
import { consola } from 'consola'
import type { DriverCapabilities } from './drivers'
import type { Role } from './types'
// Type-only. supervisor.ts imports startNoWorkerWatch from this module, so a
// runtime import here would create a cycle — use the supervisor passed in.
import type { Supervisor } from './supervisor'

const logger = consola.create({}).withTag('nuxt-concierge')

const SERVERLESS_PRESETS = [
  'vercel', 'vercel-edge', 'netlify', 'netlify-edge', 'cloudflare',
  'cloudflare-pages', 'cloudflare-module', 'aws-lambda', 'azure',
]

export interface GuardrailInput {
  role: Role
  capabilities: DriverCapabilities
  driverName: string
  queueCount: number
  isProduction: boolean
  shutdownTimeout: number
  nitroShutdownTimeout: number
  nitroShutdownDisabled: boolean
  preset?: string
}

export interface Diagnostic {
  level: 'error' | 'warn'
  message: string
}

export const guardrailDiagnostics = (input: GuardrailInput): Diagnostic[] => {
  const out: Diagnostic[] = []

  if (!input.capabilities.crossProcess && input.role !== 'both') {
    out.push({
      level: 'error',
      message:
        `The "${input.driverName}" driver keeps state in-process, so it cannot be used with role "${input.role}". `
        + `Use role "both" (a single process), or switch to a driver that works across processes, such as bullmq.`,
    })
  }

  if (!input.capabilities.persistent && input.isProduction) {
    out.push({
      level: 'warn',
      message:
        `The "${input.driverName}" driver does not persist jobs: everything queued is lost when this process exits. `
        + `This is running with NODE_ENV=production.`,
    })
  }

  if (input.role !== 'web' && input.queueCount === 0) {
    out.push({
      level: 'warn',
      message: `Role is "${input.role}" but no queues are configured, so this process will never do any work. `
        + `Declare queues in concierge.worker.queues.`,
    })
  }

  if (input.shutdownTimeout >= input.nitroShutdownTimeout) {
    out.push({
      level: 'warn',
      message:
        `concierge.worker.shutdownTimeout (${input.shutdownTimeout}ms) is not below NITRO_SHUTDOWN_TIMEOUT `
        + `(${input.nitroShutdownTimeout}ms). Nitro will abandon the drain mid-flight and exit, so workers will not `
        + `deregister. Note Nitro applies its timeout twice in sequence (HTTP drain, then close hooks), so set it to `
        + `roughly half your platform's grace period.`,
    })
  }

  if (input.nitroShutdownDisabled) {
    out.push({
      level: 'warn',
      message:
        `NITRO_SHUTDOWN_DISABLED is set, so Nitro never calls close hooks. The job drain will not run and every `
        + `deploy will drop in-flight jobs. Unset it to get graceful shutdown.`,
    })
  }

  if (input.preset && SERVERLESS_PRESETS.includes(input.preset) && !input.capabilities.persistent) {
    out.push({
      level: 'warn',
      message:
        `Preset "${input.preset}" is serverless and the "${input.driverName}" driver is not persistent. `
        + `Jobs will vanish on every cold start.`,
    })
  }

  return out
}

export const checkGuardrails = (input: GuardrailInput): void => {
  const diagnostics = guardrailDiagnostics(input)

  for (const d of diagnostics) {
    if (d.level === 'warn') logger.warn(d.message)
  }

  const fatal = diagnostics.find(d => d.level === 'error')
  if (fatal) throw new Error(`[nuxt-concierge] ${fatal.message}`)
}

const NO_WORKER_POLL_MS = 60_000
const NO_WORKER_THROTTLE_MS = 600_000

/**
 * Runs in the role: web supervisor, which starts no consumers. Deliberately
 * NOT on enqueue — that would put a registry read on the hot path.
 */
export const startNoWorkerWatch = (supervisor: Supervisor): (() => void) => {
  const lastWarned = new Map<string, number>()

  const timer = setInterval(() => {
    void (async () => {
      const s = supervisor
      if (s.getState() !== 'running') return

      try {
        const workers = await s.driver.workers()

        for (const queue of Object.keys(s.config.worker.queues)) {
          const claimed = workers.some(w => w.queues.includes(queue))
          if (claimed) continue

          const depth = await s.driver.depth(queue)
          if (depth === 0) continue

          const last = lastWarned.get(queue) ?? 0
          if (Date.now() - last < NO_WORKER_THROTTLE_MS) continue

          lastWarned.set(queue, Date.now())
          logger.warn(
            `Queue "${queue}" has ${depth} pending job(s) but no live worker is claiming it. `
            + `Start a worker process with CONCIERGE_ROLE=worker.`,
          )
        }
      }
      catch (error) {
        logger.debug('no-worker watch failed', error)
      }
    })()
  }, NO_WORKER_POLL_MS)

  timer.unref?.()
  return () => clearInterval(timer)
}
```

- [ ] **Step 4: Start the watch from the supervisor**

In `src/runtime/server/supervisor.ts`, import `startNoWorkerWatch`, add `let stopWatch: (() => void) | undefined`, and inside `startConsumers()` add an `else` branch to the `if (config.role !== 'web')` block:

```ts
else {
  stopWatch = startNoWorkerWatch(supervisor)
}
```

Then call `stopWatch?.()` at the top of `stop()`.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run test/unit`
Expected: PASS — every unit test from Tasks 2–11.

- [ ] **Step 6: Verify the build**

```bash
pnpm dev:prepare && pnpm lint && pnpm prepack
```

Expected: all pass. The real `guardrails.ts` now replaces Task 8's stub, so `checkGuardrails` actually enforces its rules for the first time — if `dev:prepare` starts failing here, read the thrown message: it is probably guardrail rule 1 firing correctly against the playground's configuration.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/server/guardrails.ts test/unit/guardrails.test.ts src/runtime/server/supervisor.ts
git commit -m "feat: add boot guardrails and the no-worker warning

Rule 1 is derived from the crossProcess capability rather than a driver name,
so it covers memory+worker and sync+worker with one rule. It throws; the rest
warn, because refusing to boot a production process over a non-persistent
driver is hostile.

Two warnings come from the verified Nitro shutdown behaviour: shutdownTimeout
must sit below NITRO_SHUTDOWN_TIMEOUT, and NITRO_SHUTDOWN_DISABLED silently
disables the drain entirely.

The no-worker watch polls every 60s in the web role, off the enqueue path."
```

---

### Task 12: Lifecycle test harness

The acceptance gate. Everything before this is unit-tested; this is what proves the guarantee.

**Files:**
- Create: `test/lifecycle/harness.ts`
- Create: `test/lifecycle/shutdown.test.ts`
- Create: `vitest.config.ts`
- Modify: `package.json`, `.github/workflows/ci.yml`, `playground/`

**Interfaces:**
- Consumes: the built playground output.
- Produces: `spawnApp()`, `enqueue()`, `readLog()`, `signal()`, `waitForReady()`.

- [ ] **Step 1: Add the playground fixtures**

Create `playground/server/jobs/slow.ts`:

```ts
import { appendFileSync } from 'node:fs'
import { defineJob } from '#concierge-handlers'

export default defineJob({
  queue: 'default',
  handler: async (ctx) => {
    const { id, attempt, payload } = ctx
    const durationMs = (payload as { durationMs?: number }).durationMs ?? 200
    await new Promise(r => setTimeout(r, durationMs))

    // Append-only so the test can read completions after the process dies.
    appendFileSync(
      process.env.CONCIERGE_TEST_LOG!,
      `${JSON.stringify({ jobId: (payload as { seq: number }).seq, attempt, pid: process.pid, id })}\n`,
    )
  },
})
```

Create `playground/server/api/enqueue.post.ts`:

```ts
import { defineEventHandler, readBody } from 'h3'
import { useQueue } from '#concierge'

export default defineEventHandler(async (event) => {
  const { count = 1, durationMs = 200 } = await readBody(event)
  const { enqueue } = useQueue()

  const ids: string[] = []
  for (let seq = 0; seq < count; seq++) {
    const { id } = await enqueue('slow', { seq, durationMs })
    ids.push(id)
  }

  return { ids }
})
```

Update `playground/nuxt.config.ts`:

```ts
concierge: {
  driver: (process.env.CONCIERGE_DRIVER as 'memory' | 'bullmq') ?? 'memory',
  connection: { url: process.env.REDIS_URL },
  worker: {
    queues: { default: 5 },
    shutdownTimeout: Number(process.env.CONCIERGE_SHUTDOWN_TIMEOUT) || 20_000,
  },
  bullmq: {
    maxStalledCount: 3,
    // 1s in tests, otherwise the force-close and SIGKILL scenarios each wait 30s+.
    stalledInterval: Number(process.env.CONCIERGE_STALLED_INTERVAL) || 30_000,
  },
},
```

Delete `playground/server/concierge/` entirely and add `useQueue` to the `#concierge` type template in `src/templates.ts`.

- [ ] **Step 2: Write the harness**

Create `test/lifecycle/harness.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AppHandle {
  proc: ChildProcess
  port: number
  logPath: string
  stop: () => void
}

export interface SpawnOptions {
  role?: 'web' | 'worker' | 'both'
  driver?: 'memory' | 'bullmq'
  shutdownTimeout?: number
  stalledInterval?: number
  port?: number
  logPath?: string
}

const OUTPUT = 'playground/.output/server/index.mjs'

export const spawnApp = async (opts: SpawnOptions = {}): Promise<AppHandle> => {
  const port = opts.port ?? 3100 + Math.floor(Math.random() * 400)
  const logPath = opts.logPath ?? join(tmpdir(), `concierge-${randomUUID()}.log`)
  writeFileSync(logPath, '')

  const proc = spawn('node', [OUTPUT], {
    env: {
      ...process.env,
      PORT: String(port),
      NITRO_PORT: String(port),
      CONCIERGE_ROLE: opts.role ?? 'both',
      CONCIERGE_DRIVER: opts.driver ?? 'memory',
      CONCIERGE_TEST_LOG: logPath,
      CONCIERGE_SHUTDOWN_TIMEOUT: String(opts.shutdownTimeout ?? 20_000),
      CONCIERGE_STALLED_INTERVAL: String(opts.stalledInterval ?? 1000),
      // Keep Nitro's own budget above ours so it is not the limiting factor.
      NITRO_SHUTDOWN_TIMEOUT: '25000',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  proc.stdout?.on('data', d => process.env.HARNESS_DEBUG && console.log(`[app] ${d}`))
  proc.stderr?.on('data', d => process.env.HARNESS_DEBUG && console.error(`[app] ${d}`))

  return {
    proc,
    port,
    logPath,
    stop: () => { try { proc.kill('SIGKILL') } catch { /* already gone */ } },
  }
}

/**
 * Polls the health endpoint rather than sleeping a fixed duration. Fixed sleeps
 * are how lifecycle tests become flaky, and a flaky lifecycle test gets skipped,
 * which removes the only regression signal for the shutdown guarantee.
 */
export const waitForReady = async (app: AppHandle, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (app.proc.exitCode !== null) {
      throw new Error(`app exited early with code ${app.proc.exitCode}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/_concierge/health`)
      if (res.status === 200) return
    }
    catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 100))
  }

  throw new Error(`app did not become ready within ${timeoutMs}ms`)
}

export const enqueue = async (app: AppHandle, count: number, durationMs: number) => {
  const res = await fetch(`http://127.0.0.1:${app.port}/api/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count, durationMs }),
  })
  if (!res.ok) throw new Error(`enqueue failed: ${res.status}`)
  return res.json() as Promise<{ ids: string[] }>
}

export interface LogLine { jobId: number, attempt: number, pid: number, id: string }

export const readLog = (app: AppHandle): LogLine[] =>
  readFileSync(app.logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as LogLine)

export const waitForExit = (app: AppHandle, timeoutMs = 40_000): Promise<number | null> =>
  new Promise((resolve, reject) => {
    if (app.proc.exitCode !== null) return resolve(app.proc.exitCode)
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs)
    app.proc.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })

export const cleanup = (app: AppHandle) => {
  app.stop()
  try { rmSync(app.logPath) } catch { /* ignore */ }
}

/** Distinct job seqs seen, and how many ran more than once. */
export const summarise = (lines: LogLine[]) => {
  const counts = new Map<number, number>()
  for (const l of lines) counts.set(l.jobId, (counts.get(l.jobId) ?? 0) + 1)
  return {
    completed: new Set(counts.keys()),
    duplicates: [...counts.entries()].filter(([, n]) => n > 1).length,
    pids: new Set(lines.map(l => l.pid)),
  }
}
```

- [ ] **Step 3: Write the lifecycle tests**

Create `test/lifecycle/shutdown.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import {
  spawnApp, waitForReady, enqueue, readLog, waitForExit, cleanup, summarise,
  type AppHandle,
} from './harness'

const DRIVERS = (process.env.REDIS_URL ? ['memory', 'bullmq'] : ['memory']) as Array<'memory' | 'bullmq'>

let app: AppHandle | undefined

beforeAll(() => {
  execSync('pnpm dev:build', { stdio: 'inherit', timeout: 300_000 })
}, 320_000)

afterEach(() => {
  if (app) cleanup(app)
  app = undefined
})

describe.each(DRIVERS)('lifecycle: %s driver', (driver) => {
  it('drains all in-flight jobs on SIGTERM', async () => {
    app = await spawnApp({ driver, role: 'both', shutdownTimeout: 20_000 })
    await waitForReady(app)
    await enqueue(app, 20, 300)

    await new Promise(r => setTimeout(r, 500)) // let some start
    app.proc.kill('SIGTERM')
    await waitForExit(app)

    const { completed, duplicates } = summarise(readLog(app))
    expect(completed.size).toBe(20)
    // Assert a BOUND, not zero. At-least-once means a clean drain may legally
    // re-run a job, so asserting zero duplicates would flake — but asserting
    // nothing would let a driver that re-runs every job pass. A clean SIGTERM
    // drain should not duplicate the majority of the batch.
    expect(duplicates).toBeLessThan(completed.size)
    console.log(`[${driver}] duplicates: ${duplicates}/${completed.size}`)
  }, 90_000)

  it('reports 503 on health once draining', async () => {
    app = await spawnApp({ driver, role: 'both' })
    await waitForReady(app)
    await enqueue(app, 5, 2000)

    app.proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 200))

    const res = await fetch(`http://127.0.0.1:${app.port}/_concierge/health`).catch(() => null)
    if (res) expect(res.status).toBe(503)

    await waitForExit(app)
  }, 90_000)

  it('exits immediately on a second signal', async () => {
    app = await spawnApp({ driver, role: 'both', shutdownTimeout: 20_000 })
    await waitForReady(app)
    await enqueue(app, 10, 5000)
    await new Promise(r => setTimeout(r, 400))

    app.proc.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 200))
    const started = Date.now()
    app.proc.kill('SIGTERM')

    await waitForExit(app, 10_000)
    expect(Date.now() - started).toBeLessThan(8000)
  }, 60_000)

  it('force-closes when the drain exceeds the budget', async () => {
    app = await spawnApp({ driver, stalledInterval: 1000, shutdownTimeout: 1000 })
    await waitForReady(app)
    await enqueue(app, 5, 10_000)
    await new Promise(r => setTimeout(r, 500))

    app.proc.kill('SIGTERM')
    const code = await waitForExit(app, 30_000)

    expect(code).not.toBeNull()
  }, 90_000)
})

describe('guardrails', () => {
  it('refuses to boot the memory driver under role: worker', async () => {
    app = await spawnApp({ driver: 'memory', role: 'worker' })
    const code = await waitForExit(app, 30_000)
    expect(code).not.toBe(0)
  }, 60_000)
})

describe.runIf(process.env.REDIS_URL)('bullmq recovery', () => {
  it('redelivers jobs abandoned by SIGKILL', async () => {
    const first = await spawnApp({ driver: 'bullmq', stalledInterval: 1000 })
    await waitForReady(first)
    await enqueue(first, 10, 4000)
    await new Promise(r => setTimeout(r, 800))

    first.proc.kill('SIGKILL')
    await waitForExit(first, 10_000)

    // Same log so the second process appends to the first's records.
    const second = await spawnApp({
      driver: 'bullmq',
      stalledInterval: 1000,
      logPath: first.logPath,
    })
    await waitForReady(second)
    await new Promise(r => setTimeout(r, 20_000))

    const { completed, pids } = summarise(readLog(second))
    expect(completed.size).toBe(10)
    // Two distinct pids proves work actually crossed the restart.
    expect(pids.size).toBe(2)

    cleanup(second)
    cleanup(first)
  }, 120_000)
})
```

- [ ] **Step 4: Split the test scripts**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/*.test.ts'],
    exclude: ['test/lifecycle/**'],
  },
})
```

Create `vitest.lifecycle.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/lifecycle/**/*.test.ts'],
    // These spawn real processes on shared ports and shared Redis keys.
    fileParallelism: false,
    hookTimeout: 320_000,
    testTimeout: 120_000,
  },
})
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:lifecycle": "vitest run --config vitest.lifecycle.config.ts"
```

`pnpm test` stays unit-only so contributors without Redis can run it.

- [ ] **Step 5: Run both suites**

```bash
pnpm test
pnpm test:lifecycle
```

Expected: `pnpm test` passes fast. `pnpm test:lifecycle` builds the playground then runs the memory-driver scenarios and the guardrail test. Without `REDIS_URL` the bullmq blocks skip via `describe.runIf`.

Then with Redis:

```bash
docker run -d -p 6379:6379 --name concierge-test redis:7
REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle
```

Expected: PASS, including the SIGKILL-recovery test proving two distinct pids.

- [ ] **Step 6: Add Redis to CI**

In `.github/workflows/ci.yml`, add to the `test` job (after `strategy`, before `steps`):

```yaml
    services:
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
```

And after the existing `- run: pnpm test` step:

```yaml
      - run: pnpm test:lifecycle
        env:
          REDIS_URL: redis://127.0.0.1:6379
```

- [ ] **Step 7: Commit**

```bash
git add test/lifecycle vitest.config.ts vitest.lifecycle.config.ts package.json .github/workflows/ci.yml playground
git rm -r playground/server/concierge
git commit -m "test: add the lifecycle harness and shutdown matrix

Spawns the real built output, sends real signals, and asserts against an
append-only log the test reads after the process dies. Duplicates are counted
and reported rather than asserted to be zero, because at-least-once is the
documented guarantee and asserting zero would flake.

Readiness comes from polling the health endpoint rather than fixed sleeps.
pnpm test stays unit-only so contributors without Redis can run it; CI runs
both with a redis:7 service."
```

---

### Task 13: Remove v1 surface area and document

**Files:**
- Delete: `src/runtime/server/handlers/defineQueue.ts`, `defineWorker.ts`, `defineCron.ts`
- Modify: `src/runtime/server/handlers/index.ts`, `src/module.ts`, `src/runtime/server/routes/ui-handler.ts`, `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: a public API of exactly `defineJob` and `useQueue`.

- [ ] **Step 1: Delete the removed handlers**

```bash
git rm src/runtime/server/handlers/defineQueue.ts \
       src/runtime/server/handlers/defineWorker.ts \
       src/runtime/server/handlers/defineCron.ts
```

Replace `src/runtime/server/handlers/index.ts` with:

```ts
export * from './defineJob'
```

- [ ] **Step 2: Fix the BullBoard route for the new config**

`ui-handler.ts` reads `$useConcierge()`, which no longer exists, and calls `createBullBoard` on every request. Replace its body with:

```ts
import { defineEventHandler, setResponseStatus } from 'h3'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { H3Adapter } from '@bull-board/h3'
import { Queue } from 'bullmq'
import { resolvePath } from 'mlly'
import { dirname } from 'pathe'
import { useRuntimeConfig } from '#imports'
import { getSupervisor } from '#concierge/supervisor'

// Built once, not per request. The previous implementation re-instantiated the
// board and its adapters on every request against a module-scoped adapter.
let handler: ((event: never) => unknown) | undefined

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().concierge
  if (!config.managementUI) {
    setResponseStatus(event, 404)
    return ''
  }

  const supervisor = getSupervisor()
  if (supervisor?.driver.name !== 'bullmq') {
    setResponseStatus(event, 503)
    return { error: `The BullBoard dashboard requires the bullmq driver (current: ${supervisor?.driver.name ?? 'none'}).` }
  }

  if (!handler) {
    const uiPath = dirname(await resolvePath('@bull-board/ui/package.json', { url: import.meta.url }))
    const serverAdapter = new H3Adapter()
    serverAdapter.setBasePath('/_concierge')

    createBullBoard({
      queues: Object.keys(config.worker.queues).map(
        name => new BullMQAdapter(new Queue(name, { connection: { ...config.connection } as never })),
      ),
      serverAdapter,
      options: { uiBasePath: uiPath, uiConfig: { boardTitle: 'Concierge' } },
    })

    handler = serverAdapter.registerHandlers().handler
  }

  return handler(event as never)
})
```

- [ ] **Step 3: Verify the whole pipeline**

```bash
pnpm dev:prepare && pnpm lint && pnpm test && pnpm prepack && pnpm dev:build
REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle
```

Expected: all pass.

- [ ] **Step 4: Rewrite the README usage sections**

Replace the "Usage" section (creating queues / workers / CRON / accessing queues) with:

````markdown
## Usage

### Defining a job

`server/jobs/send-email.ts`:

```ts
import { defineJob } from '#concierge-handlers'

export default defineJob({
  queue: 'mail',
  handler: async ({ payload }) => {
    await sendEmail(payload as { to: string })
  },
})
```

The job name defaults to the filename (`send-email`). Its queue must be declared in
`concierge.worker.queues` — a job targeting an undeclared queue fails the build rather
than silently never running.

### Enqueuing

```ts
import { useQueue } from '#concierge'

export default defineEventHandler(async () => {
  await useQueue().enqueue('send-email', { to: 'customer@example.com' })
  return true
})
```

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

`auto` uses `bullmq` when a connection URL is present, and `memory` otherwise — so
`pnpm dev` needs no Redis. In production, `auto` without a connection is a configuration
error rather than a silent fallback.

Drivers: `sync` runs handlers inline (tests), `memory` is async but in-process and loses
everything on exit (dev), `bullmq` is the persistent one (production).

## Graceful shutdown and delivery guarantees

On `SIGTERM`, concierge stops fetching new jobs, waits up to `shutdownTimeout` for in-flight
work, then force-closes and logs the IDs of anything abandoned.

**Delivery is at-least-once.** A force-closed job becomes eligible for redelivery via
BullMQ's stalled-job recovery, though once `maxStalledCount` (default 3) is exhausted it
moves to `failed`. **Handlers must be idempotent.**

Two behaviours worth knowing:

- A job abandoned at force-close is not retried until `stalledInterval` elapses (default
  30s), so you may see a pause after a deploy before work resumes.
- **Nitro applies `NITRO_SHUTDOWN_TIMEOUT` twice in sequence** — once waiting for HTTP
  connections to close, then again for shutdown hooks. With the 30s default, worst-case
  shutdown is 60s, which exceeds most platforms' grace period. Set it to roughly half your
  grace period (~12s for 30s), and keep `shutdownTimeout` below that. Concierge warns at
  boot if it is not.

If you run `role: both` alongside SSE or long-polling endpoints, prefer a dedicated worker
process: Nitro waits for those connections to close before the job drain begins.
````

Also update the FAQ's serverless answer to mention the `auto`/`memory` guardrails, and delete the badge block referencing `my-module`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat!: remove defineQueue, defineWorker and defineCron

BREAKING CHANGE: the public API is now defineJob and useQueue. Queues are
declared by concierge.worker.queues, workers are infrastructure selected by
CONCIERGE_ROLE, and the redis option becomes connection.

Cron is removed rather than carried forward: the v1 implementation ran every
cron job on the first job's schedule and obliterated the cron queue on every
boot. It returns in spec 3 as a property of defineJob.

BullBoard now builds its handler once instead of per request, and reports 503
rather than crashing when the active driver is not bullmq."
```

---

## Verification checklist

Run before opening the PR:

- [ ] `pnpm lint` — 0 errors
- [ ] `pnpm test` — all unit tests pass, no Redis required
- [ ] `REDIS_URL=redis://127.0.0.1:6379 pnpm test:lifecycle` — full matrix passes
- [ ] `pnpm prepack` — builds
- [ ] `pnpm dev:build` — playground builds under Nuxt 4
- [ ] `grep -rn "srcDir" src/` — no hits (Nuxt 4 scan-path hazard)
- [ ] `grep -rn 'defineNitroPlugin.*#imports' src/` — no hits (Prisma resolution hazard)
- [ ] `grep -rn "uneval" src/` — no hits (deserialization RCE)
- [ ] `grep -n '"0\.' src/templates.ts` — the plugin filename keeps its `0.` prefix
- [ ] `grep -rn '\^' package.json` — no unpinned dependency ranges

## Manual acceptance gate

Not automatable, and the spec makes it the gate for phase 1:

1. Deploy the playground to Railway with two process groups (`web`, and `worker` with `CONCIERGE_ROLE=worker`).
2. Enqueue 50 jobs of ~10s each.
3. Trigger a redeploy while they are in flight.
4. Confirm all 50 appear in the log, and that both app versions are visible in the worker registry during the rollover.

## Out of scope — do not build

Typed enqueue or codegen (spec 3); cron (spec 3); the custom dashboard or DevTools tab (spec 4); the introspection driver interface (spec 2); flows, chains, or batches; schema validation; the CLI; `pg-boss`; the separate lean worker entrypoint (Option B).
