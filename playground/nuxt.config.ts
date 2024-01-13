export default defineNuxtConfig({
  modules: ["../src/module"],
  concierge: {
    redis: {
      host: "localhost",
    },
    queues: ["linkedQueue"],
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
