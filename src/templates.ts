import {
  addTemplate,
  addTypeTemplate,
  createResolver,
  useNuxt,
} from "@nuxt/kit";

const importFiles = (files: string[], prefix: string = "file") =>
  files
    .map(
      (file, index) =>
        `import ${prefix}${index} from '${file.replace(/\.ts$/, "")}'`
    )
    .join("\n");

/**
 * Emits `0.concierge-nuxt-plugin.ts`. The `0.` prefix is load-bearing, not
 * cosmetic — nitro calls server plugins in array order WITHOUT awaiting them
 * (see `runNitroPlugins` in nitropack's runtime), so concierge must both sort
 * first AND register its shutdown hook synchronously (see below) to drain
 * jobs before a DB-pool plugin tears down connections under a running
 * handler.
 *
 * The default export is a bare, non-async function, NOT wrapped in
 * defineNitroPlugin and NOT itself `async`. Three constraints collide here:
 *
 * 1. Importing `defineNitroPlugin` from "#imports" breaks module resolution
 *    for some setups (notably Prisma).
 * 2. Relying on it being auto-injected does not work for a file emitted into
 *    buildDir and registered via addServerPlugin — that produced a
 *    `defineNitroPlugin is not defined` ReferenceError at runtime in the
 *    actual built output. defineNitroPlugin has no runtime behaviour (nitro
 *    defines it as the identity function, purely for typing the argument),
 *    so dropping the wrapper resolves both (1) and (2): nothing to import,
 *    nothing to resolve.
 * 3. Because nitro does not await plugins, an `async (nitroApp) => { await
 *    createSupervisor(...); ...; installShutdown(...) }` body registers its
 *    close hook only AFTER the first `await` resolves. Control returns to
 *    nitro's plugin loop at that first `await`, so a later-registered but
 *    synchronous plugin (a DB pool) can register ITS close hook first —
 *    hooks fire in registration order, not plugin-array order, so the "0."
 *    prefix alone cannot prevent the pool from closing before concierge
 *    drains. The fix: the exported function itself is synchronous. It kicks
 *    off the async work as an inner IIFE, captures the resulting promise as
 *    `ready`, and calls `installShutdown(nitroApp, ready)` synchronously
 *    immediately after — all before nitro's loop ever has a chance to move
 *    on to the next plugin. Task 9's close hook receives `ready` (a
 *    Promise<Supervisor>, not a Supervisor) and awaits it before draining.
 *
 * A rejected `ready` is also made fatal: nitro's plugin loop only try/catches
 * SYNCHRONOUS throws, so an unhandled async rejection here would otherwise
 * leave the process serving requests with no supervisor — every enqueue
 * throws "the supervisor has not started yet" and the guardrails' deliberate
 * misconfiguration throws become silently advisory instead of fatal. A
 * process that can neither enqueue nor process jobs should fail loudly and
 * exit, not degrade silently.
 *
 * IMPORTANT: this generated file, despite its .ts extension, is parsed as
 * plain JavaScript by an earlier, non-TypeScript-aware stage of nitro's own
 * rollup pipeline (a raw acorn parse of the virtual plugins module, before
 * any esbuild/TS transform runs on it) — confirmed empirically, both a
 * parameter type annotation and an `import type` statement broke the parse.
 * It must therefore contain ZERO TypeScript-only syntax: no type
 * annotations, no `import type`, no `as` casts, no generics. The `nitroApp`
 * parameter is typed via `defineConciergePlugin`'s contextual typing instead
 * (see shutdown.ts) rather than an inline annotation.
 */
export const createTemplateNuxtPlugin = (
  jobFiles: string[],
  jobNames: string[]
) => {
  const imports = importFiles(jobFiles, "job");

  const registrations = jobFiles
    .map(
      (_file, index) =>
        `  { ...job${index}, name: job${index}.name || ${JSON.stringify(
          jobNames[index]
        )} },`
    )
    .join("\n");

  const nitroPlugin = `
${imports}
import { consola } from "consola";
import { useRuntimeConfig } from "#imports";
import { resolveRole, resolveVersion } from "#concierge/role";
import { createSupervisor } from "#concierge/supervisor";
import { installShutdown, defineConciergePlugin } from "#concierge/shutdown";
import { checkGuardrails } from "#concierge/guardrails";

const jobs = [
${registrations}
];

const logger = consola.create({}).withTag("nuxt-concierge");

export default defineConciergePlugin((nitroApp) => {
  const ready = (async () => {
    const config = useRuntimeConfig().concierge;

    // Re-resolve from env at boot: the build artifact is shared across
    // processes but CONCIERGE_ROLE differs per process, so the baked-in
    // value is only a default. isDev/isProduction come from runtimeConfig
    // (resolved at build time by the module), not import.meta.dev or
    // process.env.NODE_ENV here: both are statically inlined by nitro's
    // production bundler, which would freeze whichever value was true at
    // build time into the artifact with no runtime override.
    const role = resolveRole({
      env: process.env.CONCIERGE_ROLE,
      config: config.role,
      isDev: config.isDev,
    });

    const version = resolveVersion({
      env: process.env.CONCIERGE_VERSION,
      packageVersion: config.version,
    });

    // Driver and the shutdown/stalled timeouts do NOT need a bespoke env
    // read the way CONCIERGE_ROLE and CONCIERGE_VERSION do: Nuxt already
    // applies runtime env overrides to every runtimeConfig key using the
    // NUXT_ prefix (NUXT_CONCIERGE_DRIVER, NUXT_CONCIERGE_WORKER_SHUTDOWN_TIMEOUT,
    // NUXT_CONCIERGE_BULLMQ_STALLED_INTERVAL — see
    // test/lifecycle/harness.ts), so config above already reflects
    // whatever the current process was started with. A second, custom
    // mechanism here would take silent precedence over the documented one
    // with a different naming convention and no validation.
    const supervisor = await createSupervisor({ ...config, role, jobs, version });

    checkGuardrails({
      role,
      capabilities: supervisor.driver.capabilities,
      driverName: supervisor.driver.name,
      queueCount: Object.keys(config.worker.queues).length,
      isProduction: config.isProduction,
      shutdownTimeout: config.worker.shutdownTimeout,
      nitroShutdownTimeout: Number(process.env.NITRO_SHUTDOWN_TIMEOUT) || 30000,
      nitroShutdownDisabled: Boolean(process.env.NITRO_SHUTDOWN_DISABLED),
      preset: config.preset,
    });

    await supervisor.startConsumers();
    return supervisor;
  })();

  // Registered synchronously, before any await above has a chance to resolve
  // — see the ordering note in the doc comment above createTemplateNuxtPlugin.
  installShutdown(nitroApp, ready);

  ready.catch((error) => {
    logger.error(
      "[nuxt-concierge] the supervisor failed to start; this process cannot enqueue or process jobs and is exiting",
      error
    );
    // Unconditional: this generated plugin lives only in a template string
    // emitted into buildDir and is never loaded by the unit suite (it is
    // only ever executed inside a real, separately-spawned Nitro process),
    // so there is nothing here that needs protecting from a test runner.
    // A guarded exit previously let a real guardrail failure in a real
    // deployed process keep serving traffic with no supervisor whenever
    // that process happened to have VITEST or NODE_ENV=test set from its
    // own toolchain.
    process.exit(1);
  });

  return ready;
});
  `;

  addTemplate({
    filename: "0.concierge-nuxt-plugin.ts",
    write: true,
    getContents: () => nitroPlugin,
  });
};

export const createTemplateType = () => {
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

  // Both templates declare modules that only ever exist in the nitro/server
  // build (#concierge-handlers, #concierge — see the nitro:config alias hook
  // above). Without `{ nitro: true }`, addTypeTemplate defaults to the
  // app/client graph, which leaks `declare module "#concierge"` into client
  // typings: a consumer importing `useQueue` in client code would typecheck
  // against that ambient declaration and only fail at build time, when the
  // client bundler can't actually resolve the alias.
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

  addTypeTemplate(
    {
      filename: "types/concierge.d.ts",
      write: true,
      getContents() {
        return `
  declare module "#concierge" {
    const useQueue: typeof import("${resolve(
      "./runtime/server/utils/useQueue"
    )}").useQueue;
  }
  `;
      },
    },
    { nitro: true }
  );
};

/**
 * Declares the `#concierge/*` aliases that `nitro:config` registers (see
 * `createTemplateType` below). Those aliases resolve at BUILD time but were
 * invisible to TypeScript, which is why `ui-handler.ts`'s import of
 * `#concierge/supervisor` was a TS2307 error.
 *
 * Emitted into BOTH the nitro graph AND the app graph. `ui-handler.ts` is
 * itself a registered server ROUTE (see `src/module.ts`'s `addServerHandler`
 * calls), so `nitro-routes.d.ts` references it (to type its response) and
 * drags its entire import graph — including `#concierge/supervisor` — into
 * the APP program too, the same way it does for `#concierge` (see Task 4).
 * A nitro-only declaration (`{ nitro: true }`) is therefore invisible to the
 * exact program that `pnpm typecheck` (`vue-tsc` via the app tsconfig)
 * checks, and the TS2307 persists there even though the nitro/server graph
 * resolves fine. Confirmed by direct experiment, not assumption.
 *
 * Each module below declares its exports individually as
 * `const <name>: typeof import("<path>").<name>` rather than
 * `export * from "<path>"`. `export *` was tried first and silently failed:
 * with `skipLibCheck: true` (set by every generated tsconfig here), a
 * `.d.ts`'s `export * from` that can't be resolved/typed cleanly is not
 * reported as an error — it just yields a module with zero exported
 * members, which then surfaces confusingly downstream as "has no exported
 * member 'getSupervisor'" at the IMPORT site rather than at the declaration
 * site. Do not "simplify" this back to `export *`.
 */
export const createTemplateInternalTypes = () => {
  const { resolve } = createResolver(import.meta.url);

  const modules: Record<string, { path: string; exports: string[] }> = {
    "#concierge/role": {
      path: "./runtime/server/role",
      exports: ["resolveRole", "resolveVersion"],
    },
    "#concierge/supervisor": {
      path: "./runtime/server/supervisor",
      exports: ["getSupervisor", "createSupervisor"],
    },
    "#concierge/shutdown": {
      path: "./runtime/server/shutdown",
      exports: ["installShutdown", "defineConciergePlugin"],
    },
    "#concierge/guardrails": {
      path: "./runtime/server/guardrails",
      exports: ["checkGuardrails"],
    },
  };

  const declarations = Object.entries(modules)
    .map(([specifier, { path, exports: names }]) => {
      const resolved = resolve(path);
      const members = names
        .map(
          (name) =>
            `    const ${name}: typeof import("${resolved}").${name};`
        )
        .join("\n");
      return `  declare module "${specifier}" {\n${members}\n  }`;
    })
    .join("\n");

  addTypeTemplate(
    {
      filename: "types/concierge-internal.d.ts",
      write: true,
      getContents: () => declarations,
    },
    { nitro: true }
  );

  // Same contents, no options object: registers via the `prepare:types`
  // hook (app graph / `nuxt.d.ts`) instead of `nitro:prepare:types`. Both
  // are needed — see the doc comment above.
  addTypeTemplate({
    filename: "types/concierge-internal-app.d.ts",
    write: true,
    getContents: () => declarations,
  });
};
