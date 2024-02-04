export default defineNuxtConfig({
  modules: ["../src/module"],
  concierge: {
    managementUI: true,
    redis: {
      host: "localhost",
    },
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
