import { describe, it, expect } from 'vitest'
import { buildJobMapDeclaration } from '../../src/templates'

describe('buildJobMapDeclaration', () => {
  // NOTE: deviates from the brief's literal Step 1 assertions. The brief's
  // given text expects a bare `typeof import(...)["default"]` value with no
  // wrapper — that is the job's raw `JobDefinition`, not its payload, and
  // `TypedQueue<Map>` uses `Map[K]` directly as the `enqueue` payload
  // parameter's type. Followed literally, that produced a real TS2353 in the
  // playground on a CORRECT call (`enqueue('slow', { seq, durationMs })`),
  // not merely on the deliberate errors Steps 8/9 introduce. Wrapping each
  // entry in `EnqueueInputOf<...>` (see the doc comment on
  // `buildJobMapDeclaration`) is required to make the generated map actually
  // type real call sites, which is this task's payoff.
  //
  // Asserted as ONE contiguous, full-line string per job (key, colon, the
  // `import("<typesModule>").EnqueueInputOf<...>` qualifier, and the job's
  // own import specifier all together) rather than as disjoint substrings.
  // Two disjoint `toContain` checks (one for the key, one for
  // `EnqueueInputOf<...>`) would stay green even if the
  // `import("<typesModule>").` qualifier were silently dropped — and that
  // qualifier's absence is the one silent failure mode here: an unresolvable
  // name inside a generated `.d.ts` is swallowed by `skipLibCheck`, turning
  // `Map[K]` into an error type and every `enqueue` payload into effectively
  // `any`, with no error anywhere. Disjoint substrings would also miss a
  // generator that swapped two jobs' values, since each half would still be
  // present somewhere in the output; asserting the full line per job, with
  // both jobs present, catches that too.
  it('qualifies EnqueueInputOf with the types module and pairs it to the right job', () => {
    const out = buildJobMapDeclaration(
      [
        { file: '/abs/server/jobs/send-email.ts', name: 'send-email' },
        { file: '/abs/server/jobs/mail/send.ts', name: 'mail/send' },
      ],
      '/types-module',
    )

    expect(out).toContain(
      '"send-email": import("/types-module").EnqueueInputOf<typeof import("/abs/server/jobs/send-email")["default"]>;',
    )
    expect(out).toContain(
      '"mail/send": import("/types-module").EnqueueInputOf<typeof import("/abs/server/jobs/mail/send")["default"]>;',
    )
  })

  it('strips the .ts extension from the import specifier', () => {
    const out = buildJobMapDeclaration([{ file: '/abs/server/jobs/j.ts', name: 'j' }])

    expect(out).not.toContain('j.ts')
    expect(out).toContain('/abs/server/jobs/j"')
  })

  it('augments #concierge so the declaration merges with the useQueue one', () => {
    const out = buildJobMapDeclaration([{ file: '/abs/j.ts', name: 'j' }])

    // Merging is the whole mechanism: a different module specifier here would
    // declare a second, unrelated ConciergeJobMap that useQueue never sees,
    // and every enqueue would silently fall back to the empty interface.
    expect(out).toContain('declare module "#concierge"')
    expect(out).toContain('interface ConciergeJobMap')
  })

  it('emits an empty interface body when there are no jobs', () => {
    const out = buildJobMapDeclaration([])

    expect(out).toContain('interface ConciergeJobMap')
    expect(out).not.toContain('typeof import')
  })

  it('escapes nothing unexpected into the key', () => {
    // Names come from file paths, so a quote cannot appear — but if scan.ts
    // ever changes, a broken literal must fail here rather than emit a
    // .d.ts that does not parse.
    const out = buildJobMapDeclaration([{ file: '/abs/a-b_c.1.ts', name: 'a-b_c.1' }])

    expect(out).toContain(`"a-b_c.1":`)
  })
})
