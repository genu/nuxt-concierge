export default defineNuxtConfig({
  modules: ["../src/module"],
  compatibilityDate: "2026-08-12",
  concierge: {
    managementUI: true,
    // Explicit rather than "auto": "auto" throws at boot in a production
    // build with no REDIS_URL (by design, see resolveDriverName), and the
    // playground has no Redis available in dev/CI by default. This is only
    // the DEFAULT: Nuxt applies runtime env overrides to every
    // `runtimeConfig` key using the `NUXT_` prefix, so a live per-process
    // override needs no bespoke mechanism here — NUXT_CONCIERGE_DRIVER
    // flips this without a rebuild (verified against the built output's
    // own `envPrefix: "NUXT_"`). This is how the lifecycle test harness
    // (test/lifecycle/harness.ts) builds the playground ONCE and then spawns
    // both memory- and bullmq-driver processes against that one build.
    driver: "memory",
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
    // role: "web" scenarios from the same build. Unlike driver/timeouts
    // below, CONCIERGE_ROLE is a first-class, validated, documented env
    // var (src/runtime/server/role.ts throws on an invalid value) — not
    // Nuxt's generic NUXT_ runtime-config override mechanism, so it keeps
    // its own bespoke read rather than becoming NUXT_CONCIERGE_ROLE.
    role: (process.env.CONCIERGE_ROLE as "web" | "worker" | "both") ?? "both",
    worker: {
      queues: { default: 5 },
      // Overridable per process, without a rebuild, via
      // NUXT_CONCIERGE_WORKER_SHUTDOWN_TIMEOUT.
      shutdownTimeout: 20_000,
    },
    bullmq: {
      maxStalledCount: 3,
      // 30s by default. Overridable per process via
      // NUXT_CONCIERGE_BULLMQ_STALLED_INTERVAL — the lifecycle harness sets
      // it to 1s, otherwise the force-close and SIGKILL scenarios would
      // each wait 30s+.
      stalledInterval: 30_000,
    },
  },
  imports: {
    autoImport: false,
  },
  devtools: { enabled: true },
});
