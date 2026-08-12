export default defineNuxtConfig({
  modules: ["../src/module"],
  compatibilityDate: "2026-08-12",
  concierge: {
    managementUI: true,
    // Explicit rather than "auto": "auto" throws at boot in a production
    // build with no REDIS_URL (by design, see resolveDriverName), and the
    // playground has no Redis available in dev/CI.
    driver: "memory",
    // The memory driver keeps every job in-process, so a single combined
    // process is the only coherent role for it (guardrail rule 1 in
    // src/runtime/server/guardrails.ts throws otherwise). This can't be
    // inferred from nuxt.options.dev for a built artifact — a production
    // build always bakes role: "web" by default — so it must be explicit
    // here. This is also the pattern any real user pinning driver: "memory"
    // has to follow.
    role: "both",
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
