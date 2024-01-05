import { defineNuxtModule, addPlugin, createResolver } from "@nuxt/kit";
import { type UIConfig } from "@bull-board/api/dist/typings/app";
import { name, version, configKey, compatibility } from "../package.json";
import { type RedisOptions } from "bullmq";

export interface ModuleOptions {
  connection: RedisOptions;
  uiConfig: UIConfig;
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name,
    configKey,
    version,
    compatibility,
  },
  defaults: {
    uiConfig: {
      boardTitle: "Bull Board",
    },
    connection: {
      host: "localhost",
      port: 6379,
    },
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url);

    // Do not add the extension since the `.ts` will be transpiled to `.mjs` after `npm run prepack`
    addPlugin(resolver.resolve("./runtime/plugin"));
  },
});
