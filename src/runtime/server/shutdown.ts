// Stub — Task 9 replaces this file with the bounded drain sequence.
import type { Supervisor } from './supervisor'

export interface NitroAppLike {
  hooks: { hookOnce: (name: string, fn: () => Promise<void> | void) => void }
}

/**
 * `ready` is a Promise<Supervisor>, not a Supervisor: the generated plugin
 * registers this hook synchronously, before it awaits supervisor creation
 * (see the "0." plugin ordering comment in templates.ts), so at call time
 * the supervisor does not exist yet. Task 9's close hook must `await ready`
 * (tolerating rejection) before draining.
 */
export const installShutdown = (_nitroApp: NitroAppLike, _ready: Promise<Supervisor>): void => {}

/**
 * Purely a type-inference helper — the identity function at runtime, never
 * called anywhere except to wrap the generated plugin's export.
 *
 * The generated `0.concierge-nuxt-plugin.ts` is parsed as plain JavaScript
 * by an earlier, non-TypeScript-aware stage of nitro's own rollup pipeline
 * (a raw acorn parse of the virtual plugins module, which runs before any
 * esbuild/TS transform touches this file) — confirmed empirically: both a
 * `(nitroApp: NitroAppLike) => ...` parameter annotation and an
 * `import type { NitroAppLike }` statement broke that parse with
 * "Expected ',', got ':'"/"got '{'". The generated file therefore cannot
 * contain ANY TypeScript-only syntax. Wrapping its plugin function in a
 * call to this helper lets the inner arrow function's `nitroApp` parameter
 * be typed via ordinary contextual typing instead — TypeScript infers the
 * parameter type from `defineConciergePlugin`'s own signature, so the
 * generated file needs zero additional syntax at the call site and stays
 * parseable as plain JS.
 */
export const defineConciergePlugin = (
  fn: (nitroApp: NitroAppLike) => unknown,
): (nitroApp: NitroAppLike) => unknown => fn
