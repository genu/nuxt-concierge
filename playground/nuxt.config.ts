export default defineNuxtConfig({
  modules: ["../src/module"],
  concierge: {
    redis: {
      host: "localhost",
    },
  },
  devtools: { enabled: true },
});
