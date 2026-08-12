export default defineNuxtConfig({
  modules: ["../src/module"],
  compatibilityDate: "2026-08-12",
  concierge: {
    managementUI: true,
    // Explicit rather than "auto": "auto" throws at boot in a production
    // build with no REDIS_URL (by design, see resolveDriverName), and the
    // playground has no Redis available in dev/CI.
    driver: "memory",
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
