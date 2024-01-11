import { RedisOptions } from "bullmq";
import type { UIConfig } from "@bull-board/api/dist/typings/app";

declare module "@nuxt/schema" {
  interface RuntimeConfig {
    concierge: {
      redis: RedisOptions;
      ui: UIConfig;
    };
  }
}
