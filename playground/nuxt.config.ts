export default defineNuxtConfig({
  modules: ["../src/module"],
  compatibilityDate: "2026-08-12",
  concierge: {
    managementUI: true,
    // Explicit rather than "auto": "auto" throws at boot in a production
    // build with no REDIS_URL (by design, see resolveDriverName), and the
    // playground has no Redis available in dev/CI. This expression only
    // supplies the baked-in DEFAULT for a plain `pnpm dev` / `pnpm
    // dev:build` with nothing set — the lifecycle test harness
    // (test/lifecycle/harness.ts) builds the playground ONCE and then spawns
    // many processes against that one build with different CONCIERGE_DRIVER
    // values, so the value actually used per process comes from a LIVE
    // process.env.CONCIERGE_DRIVER read in the generated plugin
    // (src/templates.ts), mirroring how CONCIERGE_ROLE already works below.
    driver: (process.env.CONCIERGE_DRIVER as "memory" | "bullmq") ?? "memory",
    connection: { url: process.env.REDIS_URL },
    // The memory driver keeps every job in-process, so a single combined
    // process is the only coherent role for it (guardrail rule 1 in
    // src/runtime/server/guardrails.ts throws otherwise). This can't be
    // inferred from nuxt.options.dev for a built artifact — a production
    // build always bakes role: "web" by default — so "both" is the
    // explicit default here; CONCIERGE_ROLE (read live, per process, by the
    // generated plugin and the role gate — see src/templates.ts and
    // src/runtime/server/middleware/role-gate.ts) always wins over this
    // baked value, which is what lets the harness run role: "worker" /
    // role: "web" scenarios from the same build.
    role: (process.env.CONCIERGE_ROLE as "web" | "worker" | "both") ?? "both",
    worker: {
      queues: { default: 5 },
      // Baked-in default only, same as `driver` above — the harness's
      // CONCIERGE_SHUTDOWN_TIMEOUT is re-read live per process in the
      // generated plugin.
      shutdownTimeout: Number(process.env.CONCIERGE_SHUTDOWN_TIMEOUT) || 20_000,
    },
    bullmq: {
      maxStalledCount: 3,
      // 1s in tests, otherwise the force-close and SIGKILL scenarios each
      // wait 30s+. Baked-in default only; CONCIERGE_STALLED_INTERVAL is
      // re-read live per process in the generated plugin, same as above.
      stalledInterval: Number(process.env.CONCIERGE_STALLED_INTERVAL) || 30_000,
    },
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
