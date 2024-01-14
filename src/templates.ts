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
        `import ${prefix}${index} from '${file.replace(".ts", "")}'`
    )
    .join("\n");

const methodFactory = (
  input: any[],
  methodName: string,
  importedKey: string,
  importedVarProps: string[]
) => {
  const r = input.map((_item, index) => {
    const argsString: string[] = [];

    for (const arg of importedVarProps) {
      argsString.push(`${importedKey}${index}.${arg}`);
    }
    return `${methodName}(${argsString.join(",")});`;
  });

  return r.join("\n\t\t");
};

export const createTemplateNuxtPlugin = (
  queues: string[],
  workers: string[],
  cron: string[],
  adhocQueues: string[],
  moduleName: string
) => {
  const nitroPlugin = `
import { useLogger } from "@nuxt/kit";
import { defineNitroPlugin } from "#imports";
import { $concierge } from "#concierge";
${importFiles(queues, "queue")}
${importFiles(workers, "worker")}
${importFiles(cron, "cron")}

const cronWorkerProcessor = async (job) => {
  const { getCronJob } = $concierge();
  const { name } = job.data;

  const cronJob = getCronJob(name);

  return await cronJob.processor();  
}

export default defineNitroPlugin(async (nitroApp) => {
    const logger = useLogger("${moduleName}");
    const { workers, createQueue, createWorker, getQueue, addCronJob } = $concierge();
    
    // CRON Queue
    const cronQueue = createQueue("CRON");

    // Empty the cron queue
    await cronQueue.obliterate();

    // CRON Worker
    createWorker("CRON", cronWorkerProcessor)

    // Add CRON Jobs      
    ${methodFactory(cron, "addCronJob", "cron", [
      "name",
      "processor",
      "schedule",
    ])}            
    
    ${cron.map((_cron, i) => {
      return `
    cronQueue.add(cron${i}.name, { name: cron${i}.name }, {
      repeat: cron${0}.schedule
    })
      `;
    })}

    // Queues
    ${methodFactory(queues, "createQueue", "queue", ["name", "opts"])}
    
    // Simple Queues
    ${adhocQueues.map((queue) => `createQueue("${queue}");`).join("\n\t\t")}

    // Workers
    ${methodFactory(workers, "createWorker", "worker", [
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

  addTemplate({
    filename: "concierge-nuxt-plugin.ts",
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
};
