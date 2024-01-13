import { defineEventHandler } from "h3";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { H3Adapter } from "@bull-board/h3";
import { useRuntimeConfig } from "#imports";
import { $concierge } from "#concierge";

const {
  concierge: { ui },
} = useRuntimeConfig();

const serverAdapter = new H3Adapter();
serverAdapter.setBasePath("/_concierge");

const bullboard = createBullBoard({
  queues: [],
  serverAdapter,
  options: {
    uiConfig: ui,
  },
});

const uiRouter = serverAdapter.registerHandlers();

export default defineEventHandler(async (event) => {
  const { queues } = $concierge();

  bullboard.replaceQueues(queues.map((queue) => new BullMQAdapter(queue)));

  return uiRouter.handler(event);
});
