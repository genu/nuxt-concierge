import { readFileSync } from "node:fs";
import {
  defineNuxtModule,
  useLogger,
  createResolver,
  addServerPlugin,
  addServerHandler,
} from "@nuxt/kit";
import defu from "defu";
import {
  withTrailingSlash,
  withoutTrailingSlash,
  cleanDoubleSlashes,
  joinURL,
} from "ufo";
import { name, version, configKey, compatibility } from "../package.json";
import { scanJobs } from "./scan";
import {
  createTemplateNuxtPlugin,
  createTemplateType,
  createTemplateInternalTypes,
} from "./templates";
import type { ModuleOptions } from "./options";
import { moduleDefaults, resolveModuleOptions } from "./options";
import { resolveRole } from "./runtime/server/role";

export type { ModuleOptions } from "./options";

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name,
    configKey,
    version,
    compatibility,
  },
  defaults: moduleDefaults,
  async setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url);
    const logger = useLogger(name);

    // Add Server handlers for UI
    addServerHandler({
      route: "/_concierge",
      handler: resolve("./runtime/server/routes/ui-handler"),
    });

    addServerHandler({
      route: "/_concierge/**",
      handler: resolve("./runtime/server/routes/ui-handler"),
    });

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
    createTemplateType();
    createTemplateInternalTypes();

    if (nuxt.options.dev) {
      const plural = (word: string, count: number) =>
        `${count} ${word}${count === 1 ? "" : "s"}`;

      logger.success(`Discovered ${plural("job", jobs.length)}`);
    }

    // Transpile BullBoard api because its not ESM
    nuxt.options.build.transpile.push("@bull-board/api");
    nuxt.options.build.transpile.push("@bull-board/h3");
    nuxt.options.build.transpile.push("@bull-board/ui");

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
    // user-supplied value is undefined in exactly the case Task 11's
    // serverless guardrail must catch. nitro.options.preset is only known
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
      const viewerUrl = `${cleanDoubleSlashes(
        joinURL(withoutTrailingSlash(nuxt.options.devServer.url), "_concierge")
      )}`;

      logger.info(`Concierge Dashboard: ${withTrailingSlash(viewerUrl)}`);
    }
  },
});
