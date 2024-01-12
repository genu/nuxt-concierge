import type { Router } from "h3";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { H3Adapter } from "@bull-board/h3";
import { useRuntimeConfig, defineEventHandler } from "#imports";
import { $concierge } from "../utils/concierge";

let uiRouter: Router;

const getUiRouter = () => {
  const { queues } = $concierge();

  const {
    concierge: { ui },
  } = useRuntimeConfig();

  if (!uiRouter) {
    const serverAdapter = new H3Adapter();
    serverAdapter.setBasePath("/_concierge");

    createBullBoard({
      queues: queues.map((queue) => new BullMQAdapter(queue)),
      serverAdapter,
      options: {
        uiConfig: ui,
      },
    });

    uiRouter = serverAdapter.registerHandlers();
  }

  return uiRouter;
};

export default defineEventHandler(getUiRouter().handler);
