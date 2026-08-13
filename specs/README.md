# nuxt-concierge v2 — specs and roadmap

v2 was decomposed into four specs, each producing working, testable software on its own.
This file is the index and the current state.

| # | Spec | State | Document |
| - | ---- | ----- | -------- |
| 1 | **Lifecycle & process model** | **Shipped** as `2.0.0-alpha` | [design](2026-08-12-concierge-v2-lifecycle-design.md) · [plan](plans/2026-08-12-concierge-v2-phase1-lifecycle.md) · [decisions](2026-08-13-phase1-decisions.md) |
| 3 | **Job API & codegen** | Not written — **recommended next** | — |
| 4 | **Dashboard** | Not written | — |
| 2 | Driver introspection SPI | Not written — **fold into spec 4** | — |

## Why the order changed

The original plan was 1 → 2 → 3 → 4. After phase 1, I would go **1 → 3 → 4**, absorbing
spec 2 into spec 4.

**Spec 2 (driver introspection) has exactly one consumer: spec 4's dashboard.** Building it
first means designing an interface against a hypothetical caller, which is how interfaces
acquire methods nobody needs and miss the ones that matter. Fold it into spec 4, where the
dashboard can shape it against real screens.

**Spec 3 is the differentiator.** Phase 1 delivered the part users do not forgive getting
wrong — workers surviving deploys — but nothing in it is a reason to *choose* this module over
wiring BullMQ directly. Typed `enqueue` is. It is also independent of specs 2 and 4, so it can
proceed immediately.

## Phase 1 outcome

Shipped as `nuxt-concierge@2.0.0-alpha` on the npm `next` tag (`latest` remains on v1), with
SLSA provenance via trusted publishing. 175 unit tests, 10 lifecycle scenarios against real
Redis including the two-process production shape.

**Read [the decisions record](2026-08-13-phase1-decisions.md) before starting spec 3.** It
carries the constraints, deferred items and hard-won facts that the design documents do not,
including several that are build-breaking if violated.

## Process notes worth carrying forward

Phase 1 ran as 13 tasks, each with an independent review and fix loop. Ten needed one, and
**essentially every defect originated in the plan's own reference code rather than in
execution.** Three would have shipped broken. The plan being detailed did not make it correct;
the per-task adversarial review is what caught them.

The single most repeated defect — eight instances — was **assertions that could not fail**:
conditionals, assertions nested in `catch` with no unconditional throw, bounds too loose to
discriminate, and one empty test body. Two were introduced *by fixes for earlier ones*.
`eslint-plugin-vitest`'s `expect-expect` and `no-conditional-expect` now catch the syntactic
forms; the semantic ones still require someone asking "would this fail if the behaviour were
removed?"

Ask that question of every assertion in spec 3.
