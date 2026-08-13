/**
 * Regression guard for the `ModuleOptions` bug: a consumer writing the
 * documented minimal config got `TS2739` because `ModuleOptions` doubled as
 * both the user-facing config type and the fully-resolved internal shape
 * (see src/options.ts). Nothing in the repo typechecked the public config
 * surface, so a broken README example shipped in 2.0.0-alpha undetected.
 *
 * This file is not run by vitest — it is compiled by `tsc --noEmit` (see
 * `test/types/tsconfig.json` and the `typecheck:public` script) purely for
 * its type-checking side effect. Every assignment below must typecheck
 * without a cast, and every `@ts-expect-error` must be a real error — if
 * TypeScript stops flagging one, `tsc` fails on an "unused directive"
 * error, so this file cannot pass by having become `any`.
 */
import type { ModuleOptions } from '../../src/options'

// The README's minimal example: only `connection`.
const onlyConnection: ModuleOptions = {
  connection: { url: process.env.REDIS_URL },
}

// The README's minimal example: only `worker.queues`.
const onlyWorkerQueues: ModuleOptions = {
  worker: { queues: { default: 5 } },
}

// A partial `worker` overriding a single field.
const partialWorkerShutdown: ModuleOptions = {
  worker: { shutdownTimeout: 10_000 },
}

// A partial `bullmq` overriding a single field.
const partialBullmq: ModuleOptions = {
  bullmq: { maxStalledCount: 5 },
}

// An empty object — everything comes from moduleDefaults.
const empty: ModuleOptions = {}

// The full documented shape should still typecheck.
const full: ModuleOptions = {
  driver: 'auto',
  connection: { url: process.env.REDIS_URL },
  worker: {
    queues: { default: 5, mail: 2 },
    shutdownTimeout: 20_000,
  },
}

// Guard against the check passing by making everything `any`: an unknown
// driver name must still be rejected.
// @ts-expect-error - 'not-a-real-driver' is not a DriverName
const invalidDriver: ModuleOptions = { driver: 'not-a-real-driver' }

// Guard against the check passing by making everything `any`: a
// wrong-typed `shutdownTimeout` must still be rejected.
// @ts-expect-error - shutdownTimeout must be a number, not a string
const invalidShutdownTimeout: ModuleOptions = { worker: { shutdownTimeout: 'soon' } }

void onlyConnection
void onlyWorkerQueues
void partialWorkerShutdown
void partialBullmq
void empty
void full
void invalidDriver
void invalidShutdownTimeout
