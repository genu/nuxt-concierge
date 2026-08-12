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
 * The default export is a bare async function, NOT wrapped in
 * defineNitroPlugin. Two constraints collide here: importing
 * `defineNitroPlugin` from "#imports" breaks module resolution for some
 * setups (notably Prisma), but relying on it being auto-injected does not
 * work for a file emitted into buildDir and registered via addServerPlugin —
 * that produced a `defineNitroPlugin is not defined` ReferenceError at
 * runtime in the actual built output. defineNitroPlugin has no runtime
 * behaviour (nitro defines it as the identity function, purely for typing
 * the argument), so dropping the wrapper entirely satisfies both constraints:
 * nothing to import, nothing to resolve.
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

export default async (nitroApp) => {
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
};
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
