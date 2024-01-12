import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { H3Adapter } from "@bull-board/h3";

const serverAdapter = new H3Adapter();
serverAdapter.setBasePath("/_concierge");

const { queues } = $concierge();

const {
  concierge: { ui },
} = useRuntimeConfig();

createBullBoard({
  queues: queues.map((queue) => new BullMQAdapter(queue)),
  serverAdapter,
  options: {
    uiConfig: ui,
  },
});

const uiRouter = serverAdapter.registerHandlers();

export default defineEventHandler(uiRouter.handler);
