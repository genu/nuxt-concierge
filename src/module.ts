import {
  defineNuxtModule,
  useLogger,
  createResolver,
  addServerPlugin,
  addServerImportsDir,
  addServerHandler,
} from "@nuxt/kit";
import pluralize from "pluralize";
import type { UIConfig } from "@bull-board/api/dist/typings/app";
import type { RedisOptions } from "bullmq";
import defu from "defu";
import { underline, yellow } from "colorette";
import {
  withTrailingSlash,
  withoutTrailingSlash,
  cleanDoubleSlashes,
  joinURL,
} from "ufo";
import { name, version, configKey, compatibility } from "../package.json";
import { isValidRedisConnection, scanFolder } from "./helplers";
import { createTemplateNuxtPlugin, createTemplateType } from "./templates";

export interface ModuleOptions {
  redis: RedisOptions;
  ui: UIConfig;
  queues: string[];
  managementUI?: boolean;
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name,
    configKey,
    version,
    compatibility,
  },
  defaults: {
    ui: {
      boardTitle: "Concierge",
    },
    redis: {
      host: "localhost",
      port: 6379,
      password: "",
    },
    queues: [],
    managementUI: process.env.NODE_ENV === "development",
  },
  async setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url);
    const logger = useLogger(name);

    // addServerImportsDir(resolve("./runtime/server/utils"));
    // addServerImportsDir(resolve("./runtime/server/handlers"));

    // Test Redis connection
    const canConnect = await isValidRedisConnection(options.redis);

    if (!canConnect) {
      logger.error(`Unable to connect to Redis instance`);
      return;
    }

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

    const workers = await scanFolder("server/concierge/workers");
    const queues = await scanFolder("server/concierge/queues");
    const cronJobs = await scanFolder("server/concierge/cron");

    createTemplateNuxtPlugin(queues, workers, cronJobs, options.queues, name);
    createTemplateType();

    if (nuxt.options.dev) {
      logger.success(
        `Created ${pluralize("queue", queues.length, true)} and ${pluralize(
          "worker",
          workers.length,
          true
        )}`
      );
    }

    nuxt.options.runtimeConfig.concierge = defu(
      nuxt.options.runtimeConfig.concierge,
      options
    );

    if (nuxt.options.dev) {
      const viewerUrl = `${cleanDoubleSlashes(
        joinURL(withoutTrailingSlash(nuxt.options.devServer.url), "_concierge")
      )}`;

      logger.info(
        `Concierge Dashboard: ${underline(
          yellow(withTrailingSlash(viewerUrl))
        )}`
      );
    }
  },
});
