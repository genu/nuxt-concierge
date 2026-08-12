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
 * Task 8 replaces this body with the real supervisor wiring (registering
 * handlers, starting workers, heartbeat, graceful shutdown). For now it only
 * proves that every discovered job module resolves and imports cleanly.
 *
 * defineNitroPlugin is intentionally NOT imported: it is auto-injected via
 * #imports, and an explicit import breaks resolution for some setups
 * (notably Prisma).
 */
export const createTemplateNuxtPlugin = (
  jobFiles: string[],
  jobNames: string[]
) => {
  const nitroPlugin = `
import { consola } from "consola";
${importFiles(jobFiles, "job")}

const jobNames = ${JSON.stringify(jobNames)};

export default defineNitroPlugin(async () => {
  const logger = consola.create({}).withTag("concierge");
  logger.info(\`Discovered \${jobNames.length} job(s): \${jobNames.join(", ")}\`);
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
  });

  addTypeTemplate({
    filename: "types/concierge-handlers.d.ts",
    write: true,
    getContents() {
      return `
  declare module "#concierge-handlers" {
   const defineQueue: typeof import("${resolve(
     "./runtime/server/handlers/defineQueue"
   )}").defineQueue;
   const defineWorker: typeof import("${resolve(
     "./runtime/server/handlers/defineWorker"
   )}").defineWorker;
   const defineCron: typeof import("${resolve(
     "./runtime/server/handlers/defineCron"
   )}").defineCron;
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
