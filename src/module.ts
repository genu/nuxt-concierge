import {
  defineNuxtModule,
  useLogger,
  createResolver,
  addServerPlugin,
  addServerImportsDir,
  addServerHandler,
  addTypeTemplate,
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
import { createTemplates } from "./templates";

export interface ModuleOptions {
  redis: RedisOptions;
  ui: UIConfig;
  queues: string[];
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
  },
  async setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url);
    const logger = useLogger(name);

    addServerImportsDir(resolve("./runtime/server/utils"));
    addServerImportsDir(resolve("./runtime/server/handlers"));

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

    addServerPlugin(resolve(nuxt.options.buildDir, "concierge-handler"));

    const workers = await scanFolder("server/concierge/workers");
    const queues = await scanFolder("server/concierge/queues");

    createTemplates(queues, workers, options.queues, name);

    if (process.dev) {
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

    nuxt.hook("nitro:config", (nitroConfig) => {
      if (!nitroConfig.alias) return;

      nitroConfig.alias["#concierge"] = resolve(
        "./runtime/server/utils/concierge"
      );
    });

    addTypeTemplate({
      filename: "types/concierge.d.ts",
      write: true,
      getContents() {
        return `
declare module "#concierge" {
  const $concierge: typeof import("${resolve(
    "./runtime/server/utils/concierge"
  )}").$concierge;
}
`;
      },
    });

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
