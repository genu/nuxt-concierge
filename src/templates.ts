import {
  addTemplate,
  addTypeTemplate,
  createResolver,
  useNuxt,
} from "@nuxt/kit";
import type { ScannedJob } from "./scan";

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
 *    on to the next plugin. `installShutdown`'s close hook (see shutdown.ts)
 *    receives `ready` (a Promise<Supervisor>, not a Supervisor) and awaits it
 *    before draining.
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

/**
 * Emits the generated half of the `#concierge` module declaration: one
 * `ConciergeJobMap` entry per scanned job, keyed by the job's name and valued
 * by the job's ENQUEUE-side payload type (the schema input when the job
 * declares one, otherwise its handler's payload type — see `EnqueueInputOf`).
 *
 * Three things make this work and all three are load-bearing:
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
 * 3. Each entry is wrapped in `EnqueueInputOf<...>`, not left as the bare
 *    `typeof import(...)["default"]`. `TypedQueue<JobMap>` (see
 *    src/runtime/server/utils/useQueue.ts) uses `JobMap[K]` directly as the
 *    `enqueue` payload parameter's type, so `JobMap[K]` must already BE the
 *    payload type. The bare default-export type is `JobDefinition<In, Out>`
 *    itself (an object with `name`/`queue`/`handler`/`run`), not a payload —
 *    confirmed empirically: without this wrapper, a correct call like
 *    `enqueue('slow', { seq, durationMs })` fails to typecheck with TS2353,
 *    because the target type is the whole job definition, not its payload.
 *
 * Names and paths come straight from `scanJobs()` so there is exactly one
 * source of truth for what a job is called.
 */
export const buildJobMapDeclaration = (
  jobs: ScannedJob[],
  // Injected so the unit test can assert the emitted text VERBATIM, including
  // the module qualification on EnqueueInputOf. Asserting it with a wildcard
  // regex would leave the qualifier's absence indistinguishable from a path
  // change, and its absence is the one silent failure mode here: an
  // unresolvable name inside a generated .d.ts is swallowed by skipLibCheck,
  // making JobMap[K] an error type and every enqueue payload effectively `any`.
  typesModule: string = createResolver(
    import.meta.url
  ).resolve("./runtime/server/types")
): string => {
  const entries = jobs
    .map(
      (job) =>
        `      ${JSON.stringify(
          job.name
        )}: import(${JSON.stringify(
          typesModule
        )}).EnqueueInputOf<typeof import(${JSON.stringify(
          job.file.replace(/\.(ts|js|mjs)$/, "")
        )})["default"]>;`
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

  // `#concierge-handlers` must ALSO be declared in BOTH graphs, for the same
  // reason `#concierge` is below: `buildJobMapDeclaration`'s app-graph copy
  // does `typeof import(job.file)["default"]` for every scanned job, which
  // pulls each job MODULE — not just its type — into the app program to
  // compute that type. Every job module imports `defineJob` from
  // `#concierge-handlers` (see `playground/server/jobs/slow.ts`), so a
  // nitro-only declaration here left that import unresolved (TS2307) in the
  // app graph as soon as a real job existed to scan. Confirmed by direct
  // experiment against the playground, not assumption.
  const conciergeHandlersModule = `
  declare module "#concierge-handlers" {
   const defineJob: typeof import("${resolve(
     "./runtime/server/handlers/defineJob"
   )}").defineJob;
  }
      `;

  // `useQueue` is declared as TypedQueue<ConciergeJobMap> rather than as
  // `typeof import(...).useQueue`: the runtime signature is deliberately
  // loose (there is no map at runtime, only the supervisor's registry), and
  // `TypedQueue<JobMap>` itself — the generic surface — is imported from the
  // source file rather than redeclared here, so ITS shape cannot drift from
  // useQueue.ts. This does NOT guarantee `useQueue`'s own signature can't
  // drift: this declaration hardcodes `() => TypedQueue<ConciergeJobMap>`
  // rather than deriving from `typeof import(...).useQueue`, so a new
  // parameter added to the real `useQueue` would go unnoticed here.
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

  // Both declarations go into BOTH graphs. See the note on
  // `createTemplateInternalTypes` below: nitro's generated `nitro-routes.d.ts`
  // references every server route handler to type $fetch, which pulls those
  // handlers into the APP program — so a route that imports `#concierge`
  // fails with TS2307 there unless the app graph has the declaration too.
  //
  // The cost, accepted deliberately: client code now typechecks against
  // these ambient declarations too, so `import { useQueue } from '#concierge'`
  // or `import { defineJob } from '#concierge-handlers'` in client code
  // compiles fine and only fails later, at build time, when the client
  // bundler can't actually resolve the alias. That footgun is loud and
  // visible in review; breaking correct server code (the TS2307 above) is
  // worse than failing to prevent incorrect client code.
  for (const [suffix, options] of [
    ["", { nitro: true as const }],
    ["-app", undefined],
  ] as const) {
    addTypeTemplate(
      {
        filename: `types/concierge-handlers${suffix}.d.ts`,
        write: true,
        getContents: () => conciergeHandlersModule,
      },
      options
    );

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

/**
 * Declares the `#concierge/*` aliases that `nitro:config` registers (see
 * `createTemplateType` above). Those aliases resolve at BUILD time but are
 * invisible to TypeScript on their own — a server route file importing one
 * directly needs the app-graph declaration below, not just the nitro one.
 * The bull-board `ui-handler.ts` route (removed when bull-board was replaced
 * by the dashboard's own routes under `routes/api/`) hit exactly this as a
 * TS2307 error on its `#concierge/supervisor` import, which is what proved
 * the need for dual emission below.
 *
 * Emitted into BOTH the nitro graph AND the app graph. A registered server
 * ROUTE (see `src/module.ts`'s `addServerHandler` calls) that imports one of
 * these aliases has its whole import graph dragged into the APP program too
 * — `nitro-routes.d.ts` references the route (to type its response), and
 * that reference is what pulls it in, the same way it does for `#concierge`
 * (see the note on `createTemplateType` above). A nitro-only declaration
 * (`{ nitro: true }`) would therefore be invisible to the exact program that
 * `pnpm typecheck` (`vue-tsc` via the
 * app tsconfig) checks. Confirmed by direct experiment against `ui-handler.ts`
 * at the time, not assumption. None of the dashboard's current routes import
 * these aliases directly (they use relative imports instead), but that does
 * not make the app-graph emission removable — it protects the next route
 * that does, the same way it protected the one that no longer exists.
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
