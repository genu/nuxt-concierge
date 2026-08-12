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
 * cosmetic — nitro close hooks run in registration order, so concierge must
 * register FIRST to drain jobs before a DB-pool plugin tears down connections
 * under a running handler.
 *
 * defineNitroPlugin is intentionally NOT imported: it is auto-injected via
 * #imports, and an explicit import breaks resolution for some setups
 * (notably Prisma).
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
import { useRuntimeConfig } from "#imports";
import { resolveRole, resolveVersion } from "#concierge/role";
import { createSupervisor } from "#concierge/supervisor";
import { installShutdown } from "#concierge/shutdown";
import { checkGuardrails } from "#concierge/guardrails";

const jobs = [
${registrations}
];

export default defineNitroPlugin(async (nitroApp) => {
  const config = useRuntimeConfig().concierge;

  // Re-resolve from env at boot: the build artifact is shared across processes
  // but CONCIERGE_ROLE differs per process, so the baked-in value is only a
  // default.
  const role = resolveRole({
    env: process.env.CONCIERGE_ROLE,
    config: config.role,
    isDev: import.meta.dev,
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
    isProduction: process.env.NODE_ENV === "production",
    shutdownTimeout: config.worker.shutdownTimeout,
    nitroShutdownTimeout: Number(process.env.NITRO_SHUTDOWN_TIMEOUT) || 30000,
    nitroShutdownDisabled: Boolean(process.env.NITRO_SHUTDOWN_DISABLED),
    preset: config.preset,
  });

  await supervisor.startConsumers();
  installShutdown(nitroApp, supervisor);
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
