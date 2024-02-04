import { defineEventHandler, setResponseStatus } from "h3";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { H3Adapter } from "@bull-board/h3";
import { useRuntimeConfig } from "#imports";
import { $useConcierge } from "#concierge";
import { consola } from "consola";
import { resolvePath } from "mlly";
import { dirname } from "pathe";

const serverAdapter = new H3Adapter();
serverAdapter.setBasePath("/_concierge");

export default defineEventHandler(async (event) => {
  const {
    concierge: { ui, managementUI },
  } = useRuntimeConfig();

  const logger = consola.create({}).withTag("nuxt-concierge");
  const uiPath = dirname(
    await resolvePath("@bull-board/ui/package.json", {
      url: import.meta.url,
    })
  );

  if (!managementUI) {
    logger.warn("Concierge is disabled");
    setResponseStatus(event, 404);

    return "";
  }

  const { queues } = $useConcierge();

  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
    options: {
      uiBasePath: uiPath,
      uiConfig: ui,
    },
  });

  const uiRouter = serverAdapter.registerHandlers();

  return uiRouter.handler(event);
});
