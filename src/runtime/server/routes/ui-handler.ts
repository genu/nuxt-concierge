import { defineEventHandler, setResponseStatus } from "h3";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { H3Adapter } from "@bull-board/h3";
import { useRuntimeConfig } from "#imports";
import { $useConcierge } from "#concierge";
import { consola } from "consola";

const {
  concierge: { ui, managementUI },
} = useRuntimeConfig();

const serverAdapter = new H3Adapter();
serverAdapter.setBasePath("/_concierge");

const root = import.meta.dev ? "../" : "../../";

const bullboard = createBullBoard({
  queues: [],
  serverAdapter,
  options: {
    uiBasePath: `${root}node_modules/@bull-board/ui`,
    uiConfig: ui,
  },
});

const uiRouter = serverAdapter.registerHandlers();

export default defineEventHandler(async (event) => {
  const logger = consola.create({}).withTag("nuxt-concierge");

  if (!managementUI) {
    logger.warn("Concierge is disabled");
    setResponseStatus(event, 404);

    return "";
  }

  const { queues } = $useConcierge();

  bullboard.replaceQueues(queues.map((queue) => new BullMQAdapter(queue)));

  return uiRouter.handler(event);
});
