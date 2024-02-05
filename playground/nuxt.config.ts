export default defineNuxtConfig({
  modules: ["../src/module"],
  concierge: {
    managementUI: true,
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
