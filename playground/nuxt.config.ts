export default defineNuxtConfig({
  modules: ["../src/module"],
  concierge: {
    redis: {
      host: "localhost",
    },
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
