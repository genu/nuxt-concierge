import { addTemplate } from "@nuxt/kit";

export const importFiles = (files: string[], prefix: string = "file") =>
  files
    .map(
      (file, index) =>
        `import ${prefix}${index} from '${file.replace(".ts", "")}'`
    )
    .join("\n");

export const methodFactory = (
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

export const createTemplates = (
  queues: string[],
  workers: string[],
  adhocQueues: string[],
  moduleName: string
) => {
  const nitroPlugin = `
import { useLogger } from "@nuxt/kit";
import { defineNitroPlugin } from "#imports";
import { $concierge } from "#concierge";
${importFiles(queues, "queue")}
${importFiles(workers, "worker")}
        
export default defineNitroPlugin(async (nitroApp) => {
    const logger = useLogger("${moduleName}");
    const { workers, createQueue, createWorker } = $concierge();
    
    // Queues
    ${methodFactory(queues, "createQueue", "queue", ["name", "opts"])}
    
    // Adhoc Queues
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
    filename: "concierge-handler.ts",
    write: true,
    getContents: () => nitroPlugin,
  });
};
