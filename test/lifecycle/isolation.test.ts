import { describe, it, expect, afterAll } from 'vitest'
import { spawnApp, waitForReady, readLog, cleanup, killAllSpawned, type AppHandle } from './harness'

/**
 * The playground is ONE fixture set shared by every lifecycle scenario, and
 * nothing else in this suite states what a scenario expects to be running. So
 * a fixture that does work on its own — a cron job, a boot-time self-enqueue —
 * silently changes every other scenario, and shows up somewhere else entirely
 * as an off-by-one that reads like a driver bug.
 *
 * That is not hypothetical. `playground/server/jobs/heartbeat-digest.ts` was
 * added with `cron: '* * * * *'` for the cron scenario, reconciled in every
 * scenario (they all spawn a worker role), and appended to the shared
 * `CONCIERGE_TEST_LOG` — turning the SIGKILL-recovery scenario into
 * `expected 11 to be 10` on CI. Neither the task review nor the whole-branch
 * review caught it, because the fixture is entirely reasonable read on its own.
 *
 * This file exists so the SHARED RESOURCE asserts its own invariant instead:
 *
 *   A freshly spawned app does no work until a scenario asks it to.
 *
 * If that ever stops holding, this fails directly and says why, rather than
 * skewing a count in a scenario three files away.
 */
describe('playground fixture isolation', () => {
  let app: AppHandle | undefined

  afterAll(() => {
    if (app) cleanup(app)
    killAllSpawned()
  })

  it('does no work until a scenario enqueues', async () => {
    // Default spawn: exactly what every non-cron scenario gets. Notably
    // `cronEnabled` defaults to false, so this also asserts that default is
    // actually wired through to the built output and not just declared.
    app = await spawnApp({ driver: 'memory' })
    await waitForReady(app)

    // First window: catches anything that acts at boot — a self-enqueueing
    // fixture, a job scheduled with a sub-minute expression, an eager consumer.
    await new Promise(r => setTimeout(r, 5_000))
    expect(readLog(app)).toEqual([])

    // Second window: crosses a full minute boundary, which is what it takes to
    // catch a `* * * * *` fixture — the actual shape that caused the CI
    // failure. 70s rather than 60s so a boot landing just after a minute tick
    // still spans the next one. This is the slowest test in the suite and it
    // earns that: a minute-granularity schedule is invisible to every faster
    // check, and it is exactly the case that shipped.
    await new Promise(r => setTimeout(r, 65_000))
    expect(readLog(app)).toEqual([])
  }, 120_000)
})
