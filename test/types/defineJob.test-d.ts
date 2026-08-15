import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'
import type { AnyJobDefinition, EnqueueInputOf, JobDefinition, JobPayloadOf } from '../../src/runtime/server/types'

interface SendEmailPayload {
  to: string
  subject: string
}

describe('defineJob with an explicit type argument', () => {
  it('types ctx.payload as the type argument', () => {
    defineJob<SendEmailPayload>({
      queue: 'default',
      handler: (ctx) => {
        expectTypeOf(ctx.payload).toEqualTypeOf<SendEmailPayload>()
      },
    })
  })

  it('carries the type argument into both JobDefinition parameters', () => {
    const job = defineJob<SendEmailPayload>({ handler: () => {} })
    expectTypeOf(job).toEqualTypeOf<JobDefinition<SendEmailPayload, SendEmailPayload>>()
  })

  it('is recoverable by EnqueueInputOf', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used below via `typeof job`, a type-only reference
    const job = defineJob<SendEmailPayload>({ handler: () => {} })
    expectTypeOf<EnqueueInputOf<typeof job>>().toEqualTypeOf<SendEmailPayload>()
  })

  // eslint-disable-next-line vitest/expect-expect -- the @ts-expect-error below IS the assertion; there is no runtime expectTypeOf call to make
  it('rejects an input schema alongside an explicit type argument', () => {
    defineJob<SendEmailPayload>({
      // @ts-expect-error `input` is `never` on the type-argument overload;
      // two sources of truth for the payload type must not silently disagree.
      input: z.object({ to: z.string() }),
      handler: () => {},
    })
  })
})

describe('defineJob with an input schema', () => {
  const input = z.object({
    id: z.string().transform(Number),
    label: z.string().default('none'),
  })

  it('types ctx.payload as the schema OUTPUT', () => {
    defineJob({
      input,
      handler: (ctx) => {
        expectTypeOf(ctx.payload).toEqualTypeOf<{ id: number, label: string }>()
      },
    })
  })

  it('types the enqueue side as the schema INPUT', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used below via `typeof job`, a type-only reference
    const job = defineJob({ input, handler: () => {} })
    expectTypeOf<EnqueueInputOf<typeof job>>().toEqualTypeOf<{ id: string, label?: string | undefined }>()
  })

  it('keeps INPUT and OUTPUT distinct for a transforming schema', () => {
    // The assertion that catches a regression to "enqueue the transformed
    // output". If In and Out ever collapse to the same type, the producer
    // would be typed to send what only the consumer should ever see.
    //
    // Uses JobPayloadOf rather than a hand-rolled
    // `T extends JobDefinition<unknown, infer O>`: pinning a parameter instead
    // of inferring it is the fragile pattern documented on EnqueueInputOf, and
    // a conditional that silently falls through to `never` here would make
    // `not.toEqualTypeOf` pass for the wrong reason.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used below via `typeof job`, a type-only reference
    const job = defineJob({ input, handler: () => {} })
    type In = EnqueueInputOf<typeof job>
    type Out = JobPayloadOf<typeof job>

    expectTypeOf<In>().not.toEqualTypeOf<Out>()
    expectTypeOf<In['id']>().toEqualTypeOf<string>()
    expectTypeOf<Out['id']>().toEqualTypeOf<number>()
  })
})

describe('AnyJobDefinition', () => {
  it('accepts a typed job in a collection via AnyJobDefinition', () => {
    const job = defineJob<SendEmailPayload>({ handler: () => {} })
    expectTypeOf([job]).toExtend<AnyJobDefinition[]>()
  })

  // eslint-disable-next-line vitest/expect-expect -- the @ts-expect-error below IS the assertion; there is no runtime expectTypeOf call to make
  it('rejects a typed job where the bare JobDefinition element type is required', () => {
    const job = defineJob<SendEmailPayload>({ handler: () => {} })
    // @ts-expect-error property-syntax `handler` is contravariant, so a typed job
    // is not assignable to JobDefinition<unknown, unknown> — this is why
    // AnyJobDefinition exists.
    const bare: JobDefinition[] = [job]
    void bare
  })
})

describe('defineJob with neither', () => {
  it('resolves the payload to unknown', () => {
    // Recorded deliberately: an untyped job is an accepted gap, not a bug.
    // `enqueue` on it accepts anything. Asserting it here means a future
    // change to `never` or `any` shows up as a failing test rather than as a
    // silent shift in how much safety the library provides.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used below via `typeof job`, a type-only reference
    const job = defineJob({ handler: (ctx) => {
      expectTypeOf(ctx.payload).toEqualTypeOf<unknown>()
    } })
    expectTypeOf<EnqueueInputOf<typeof job>>().toEqualTypeOf<unknown>()
  })
})

// `uniqueId` receives the schema INPUT, not its output. Here the schema
// transforms string -> number, so `Out` is `{ n: number }` and `In` is
// `{ n: string }`; typing against `Out` would promise the handler's shape to a
// function that runs before the transform ever applies.
defineJob({
  input: z.object({ n: z.string().transform(Number) }),
  uniqueId: (payload) => {
    expectTypeOf(payload).toEqualTypeOf<{ n: string }>()
    return payload.n
  },
  handler: async (ctx) => {
    // Paired with the above deliberately: the handler DOES see the output.
    // Asserting only the uniqueId side would pass for an implementation that
    // typed both as the input.
    expectTypeOf(ctx.payload).toEqualTypeOf<{ n: number }>()
  },
})

// The no-schema case: In defaults to Out, so both are the type argument.
defineJob<{ id: number }>({
  uniqueId: (payload) => {
    expectTypeOf(payload).toEqualTypeOf<{ id: number }>()
    return String(payload.id)
  },
  handler: async () => {},
})

// `ctx.cron` is optional and correctly shaped on every job, scheduled or not —
// a handler cannot know at compile time whether a given run came from a tick.
defineJob({
  cron: '0 9 * * *',
  handler: async (ctx) => {
    expectTypeOf(ctx.cron).toEqualTypeOf<{ tick: number, expression: string, tz: string } | undefined>()
  },
})

// @ts-expect-error — a cron job may not declare an unknown option, which is
// what keeps a typo'd `crons:` from silently defining a job that never fires.
defineJob({ crons: '0 9 * * *', handler: async () => {} })

// The positive twin of the negative above. `@ts-expect-error` passes if ANY
// error occurs on the line, including an unrelated typo, so it proves nothing
// without this.
defineJob({ cron: '0 9 * * *', handler: async () => {} })
