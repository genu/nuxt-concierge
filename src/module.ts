import { readFileSync } from "node:fs";
import {
  defineNuxtModule,
  useLogger,
  createResolver,
  addServerPlugin,
  addServerHandler,
} from "@nuxt/kit";
import { addCustomTab } from "@nuxt/devtools-kit";
import defu from "defu";
import { name, version, configKey, compatibility } from "../package.json";
import { scanJobs } from "./scan";
import {
  createTemplateNuxtPlugin,
  createTemplateType,
  createTemplateInternalTypes,
} from "./templates";
import type { ModuleOptions } from "./options";
import { resolveModuleOptions } from "./options";
import { resolveRole } from "./runtime/server/role";

export type { ModuleOptions } from "./options";

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name,
    configKey,
    version,
    compatibility,
  },
  // Deliberately NOT `defaults: moduleDefaults`. @nuxt/kit runs
  // `defu(inlineOptions, nuxtConfigOptions, optionsDefaults)` before setup()
  // executes, and defu deep-merges — so a `defaults` option here would merge
  // the user's `worker.queues` map with moduleDefaults.worker.queues before
  // `resolveModuleOptions` below ever sees it, silently reintroducing the
  // `default` queue underneath any replacement queue map the user declared.
  // `resolveModuleOptions` is the single resolution point and already fills
  // every field from `moduleDefaults` itself.
  async setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url);
    const logger = useLogger(name);

    addServerHandler({
      route: "/_concierge/health",
      handler: resolve("./runtime/server/routes/health"),
    });

    addServerHandler({
      middleware: true,
      handler: resolve("./runtime/server/middleware/role-gate"),
    });

    addServerPlugin(resolve(nuxt.options.buildDir, "0.concierge-nuxt-plugin"));

    const jobs = await scanJobs();

    createTemplateNuxtPlugin(
      jobs.map((job) => job.file),
      jobs.map((job) => job.name)
    );
    createTemplateType(jobs);
    createTemplateInternalTypes();

    if (nuxt.options.dev) {
      const plural = (word: string, count: number) =>
        `${count} ${word}${count === 1 ? "" : "s"}`;

      logger.success(`Discovered ${plural("job", jobs.length)}`);
    }

    // Everything below is DEV-ONLY, gated at registration time rather than by a
    // runtime flag. `managementUI` used to make this a config key a user could
    // flip on in production, where /_concierge sat behind nothing but the
    // worker-role gate — a queue dashboard with a retry button and no auth
    // should not be one option away.
    if (nuxt.options.dev) {
      const clientDir = resolve("../dist/client");

      // /_concierge/ui, NOT /_concierge: registering the SPA's static assets
      // at the /_concierge baseURL itself was tried first and confirmed by
      // direct experiment to shadow every sibling server route under that
      // prefix — /_concierge/health returned 404 once this hook ran, and the
      // same happens to every /_concierge/api/** route below. This is the
      // fallback the spec named for exactly this outcome. /_concierge/health
      // and /_concierge/api/** stay ordinary server routes with nothing
      // shadowing them.
      nuxt.hook("nitro:config", (nitroConfig) => {
        nitroConfig.publicAssets ||= [];
        nitroConfig.publicAssets.push({ dir: clientDir, baseURL: "/_concierge/ui", maxAge: 0 });
      });

      // Every dashboard API route. `method` is `get` for every plain read and
      // `post` for the one route with a side effect (`jobs-retry`) — a dev
      // server is reachable from any page a developer happens to visit, so
      // without a method constraint a bare `GET` to the retry route would
      // perform the retry too. The four reads have no side effect either way,
      // but are constrained anyway so the route's contract matches what it
      // actually does rather than accepting anything.
      const API_HANDLERS: Record<string, { handler: string; method: "get" | "post" }> = {
        "/_concierge/api/overview": { handler: "./runtime/server/routes/api/overview", method: "get" },
        "/_concierge/api/queues/:queue/jobs": { handler: "./runtime/server/routes/api/jobs-list", method: "get" },
        "/_concierge/api/queues/:queue/jobs/:id": { handler: "./runtime/server/routes/api/jobs-detail", method: "get" },
        "/_concierge/api/queues/:queue/jobs/:id/retry": { handler: "./runtime/server/routes/api/jobs-retry", method: "post" },
        "/_concierge/api/registry": { handler: "./runtime/server/routes/api/registry", method: "get" },
        "/_concierge/api/schedules": { handler: "./runtime/server/routes/api/schedules-list", method: "get" },
        "/_concierge/api/schedules/:name/run": { handler: "./runtime/server/routes/api/schedules-run", method: "post" },
      };

      for (const [route, { handler, method }] of Object.entries(API_HANDLERS)) {
        addServerHandler({ route, handler: resolve(handler), method });
      }

      // Dev-only, and it must STAY dev-only: these are absolute build-machine
      // paths, and baking them into a production runtimeConfig would ship one
      // developer's directory layout to every deployment.
      nuxt.options.runtimeConfig.concierge = defu(
        {
          jobFiles: Object.fromEntries(jobs.map((job) => [job.name, job.file])),
          generatedTypesPath: `${nuxt.options.buildDir}/types/concierge-jobs.d.ts`,
        },
        nuxt.options.runtimeConfig.concierge
      );

      addCustomTab({
        name: "concierge",
        title: "Concierge",
        icon: "carbon:queued",
        view: { type: "iframe", src: "/_concierge/ui/" },
      });
    }

    const resolved = resolveModuleOptions(options);

    nuxt.options.runtimeConfig.concierge = defu(
      nuxt.options.runtimeConfig.concierge,
      resolved
    );

    const role = resolveRole({
      env: process.env.CONCIERGE_ROLE,
      config: resolved.role,
      isDev: nuxt.options.dev,
    });

    // Read at build time; the runtime lets CONCIERGE_VERSION override it, because
    // a git SHA is usually injected into the deployed process, not the build.
    let packageVersion: string | undefined;
    try {
      packageVersion = JSON.parse(
        readFileSync(`${nuxt.options.rootDir}/package.json`, "utf8")
      ).version;
    } catch {
      packageVersion = undefined;
    }

    // One signal for "dev", resolved once at build time and reused
    // everywhere at runtime, rather than two: resolveRole previously read
    // import.meta.dev while the driver/guardrail path read
    // process.env.NODE_ENV. Both are statically inlined by nitro's
    // production bundler, which freezes whichever value was true at BUILD
    // time into the artifact — reading them at runtime is not just
    // redundant, it is a lie for anyone who sets NODE_ENV on the deployed
    // process expecting it to matter. Baking the resolved booleans into
    // runtimeConfig instead keeps them overridable via the standard
    // NUXT_CONCIERGE_IS_DEV / NUXT_CONCIERGE_IS_PRODUCTION env vars.
    const isDev = nuxt.options.dev;

    nuxt.options.runtimeConfig.concierge = defu(
      { role, version: packageVersion ?? "unknown", isDev, isProduction: !isDev },
      nuxt.options.runtimeConfig.concierge,
      resolved
    );

    // The preset a user configures explicitly (nuxt.options.nitro.preset) is
    // not the same thing as the preset nitro actually resolves: serverless
    // targets (Vercel/Netlify/Cloudflare) are usually auto-detected, so the
    // user-supplied value is undefined in exactly the case the serverless
    // guardrail in checkGuardrails (src/runtime/server/guardrails.ts) must
    // catch. nitro.options.preset is only known
    // once nitro itself has finished resolving it, which is after this
    // setup() function returns — hence the nitro:init hook rather than
    // reading it here.
    nuxt.hook("nitro:init", (nitro) => {
      const runtimeConfig = nitro.options.runtimeConfig as
        | { concierge?: Record<string, unknown> }
        | undefined;

      if (runtimeConfig?.concierge) {
        runtimeConfig.concierge.preset = nitro.options.preset;
      }
    });

    logger.info(`Role: ${role}`);

    if (nuxt.options.dev) {
      // No URL, which is how #24 is fixed: setup() runs BEFORE the server
      // listens, so nuxt.options.devServer.url is not yet correct here — it
      // logged port 3000 whenever 3000 was taken. Pointing at the DevTools tab
      // leaves no port to get wrong.
      logger.info("Concierge dashboard: open the Concierge tab in Nuxt DevTools");
    }
  },
});
