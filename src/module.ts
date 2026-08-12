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
import { createTemplateNuxtPlugin, createTemplateType } from "./templates";
import type { ModuleOptions } from "./options";
import { moduleDefaults } from "./options";
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

    addServerPlugin(resolve(nuxt.options.buildDir, "0.concierge-nuxt-plugin"));

    const jobs = await scanJobs();

    createTemplateNuxtPlugin(
      jobs.map((job) => job.file),
      jobs.map((job) => job.name)
    );
    createTemplateType();

    if (nuxt.options.dev) {
      const plural = (word: string, count: number) =>
        `${count} ${word}${count === 1 ? "" : "s"}`;

      logger.success(`Discovered ${plural("job", jobs.length)}`);
    }

    // Transpile BullBoard api because its not ESM
    nuxt.options.build.transpile.push("@bull-board/api");
    nuxt.options.build.transpile.push("@bull-board/h3");
    nuxt.options.build.transpile.push("@bull-board/ui");

    nuxt.options.runtimeConfig.concierge = defu(
      nuxt.options.runtimeConfig.concierge,
      options
    );

    const role = resolveRole({
      env: process.env.CONCIERGE_ROLE,
      config: options.role,
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

    // Resolved at build time, not read from the nitro preset at runtime: the
    // guardrail check only needs it to warn about serverless presets, and
    // nuxt.options.nitro.preset is the reliable source for that.
    const preset = nuxt.options.nitro?.preset;

    nuxt.options.runtimeConfig.concierge = defu(
      { role, version: packageVersion ?? "unknown", preset },
      nuxt.options.runtimeConfig.concierge,
      options
    );

    logger.info(`Role: ${role}`);

    if (nuxt.options.dev) {
      const viewerUrl = `${cleanDoubleSlashes(
        joinURL(withoutTrailingSlash(nuxt.options.devServer.url), "_concierge")
      )}`;

      logger.info(`Concierge Dashboard: ${withTrailingSlash(viewerUrl)}`);
    }
  },
});
