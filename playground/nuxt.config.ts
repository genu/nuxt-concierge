export default defineNuxtConfig({
  modules: ["../src/module"],
  compatibilityDate: "2026-08-12",
  concierge: {
    managementUI: true,
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
