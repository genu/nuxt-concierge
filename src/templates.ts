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
import { consola } from "consola";
import { defineNitroPlugin } from "#imports";
import { $useConcierge } from "#concierge";
${importFiles(queues, "queue")}
${importFiles(workers, "worker")}
${importFiles(cron, "cron")}

const cronWorkerProcessor = async (job) => {
  const { getCronJob } = $useConcierge();
  const { name } = job.data;

  const cronJob = getCronJob(name);

  return await cronJob.processor(job);  
}

export default defineNitroPlugin(async (nitroApp) => {
    const logger = consola.create({}).withTag("${moduleName}")
    const { workers, createQueue, createWorker, addCronJob } = $useConcierge();
    
    // CRON Queue
    const cronQueue = createQueue("CRON");

    // Remove old cron jobs
    await cronQueue.obliterate({force: true})

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
