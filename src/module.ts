import {
  defineNuxtModule,
  useLogger,
  createResolver,
  addTemplate,
  addServerPlugin,
  addServerImportsDir,
  addServerHandler,
} from "@nuxt/kit";
import type { UIConfig } from "@bull-board/api/dist/typings/app";
import type { RedisOptions } from "bullmq";
import fg from "fast-glob";
import defu from "defu";
import pluralize from "pluralize";
import { underline, yellow } from "colorette";
import {
  withTrailingSlash,
  withoutTrailingSlash,
  cleanDoubleSlashes,
  joinURL,
} from "ufo";
import { name, version, configKey, compatibility } from "../package.json";
import { template, isValidRedisConnection } from "./utils";

export interface ModuleOptions {
  redis: RedisOptions;
  ui: UIConfig;
}

async function scanHandlers(path: string): Promise<string[]> {
  const files: string[] = [];

  const updatedFiles = await fg("**/*.{ts,js,mjs}", {
    cwd: path,
    absolute: true,
    onlyFiles: true,
  });

  files.push(...new Set(updatedFiles));

  return files;
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

    const workers = await scanHandlers(
      resolve(nuxt.options.srcDir, `server/concierge/workers`)
    );

    const queues = await scanHandlers(
      resolve(nuxt.options.srcDir, `server/concierge/queues`)
    );

    logger.success(
      `Loaded ${workers.length} ${pluralize("worker", workers.length)} and ${
        queues.length
      } ${pluralize("queue", queues.length)}`
    );

    addTemplate({
      filename: "concierge-handler.ts",
      write: true,
      getContents() {
        return `
import { useLogger } from "@nuxt/kit";
${template.importFiles(queues, "queue")}
${template.importFiles(workers, "worker")}
        
export default defineNitroPlugin(async (nitroApp) => {
    const logger = useLogger("${name}");
    const { workers, createQueue, createWorker } = $concierge();

    ${template.methodFactory(queues, "createQueue", "queue", ["name", "opts"])}
    ${template.methodFactory(workers, "createWorker", "worker", [
      "name",
      "processor",
      "opts",
    ])}

    nitroApp.hooks.hookOnce("close", async () => {
      logger.info("Stopping " + workers.length + " workers");

      await Promise.all(workers.map((worker) => worker.close()));
    })
})
        `;
      },
    });

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
