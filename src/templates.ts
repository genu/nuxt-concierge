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
    // Guarded so a failure surfaced under a test runner does not kill the
    // test process itself; production behaviour is unaffected.
    if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
      process.exit(1);
    }
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
      "./runtime/server/utils/concierge"
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

  addTypeTemplate({
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
  });

  addTypeTemplate({
    filename: "types/concierge.d.ts",
    write: true,
    getContents() {
      return `
  declare module "#concierge" {
    const $useConcierge: typeof import("${resolve(
      "./runtime/server/utils/concierge"
    )}").$useConcierge;
  }
  `;
    },
  });
};
