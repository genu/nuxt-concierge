import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { defineJob } from '../../src/runtime/server/handlers/defineJob'
import type { TypedQueue } from '../../src/runtime/server/utils/useQueue'
import type { EnqueueInputOf } from '../../src/runtime/server/types'

/**
 * Stands in for the generated ConciergeJobMap. The real one is an ambient
 * declaration produced at build time, which a type test cannot import — so
 * this asserts the SHAPE the generator targets: keys are job names, values
 * are job-module default export types, and TypedQueue reads through
 * EnqueueInputOf. `test/unit/templates.test.ts` covers the generator's
 * output text; together they cover both halves.
 */
interface SendEmailPayload {
  to: string
  subject: string
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used below via `typeof sendEmail`, a type-only reference
const sendEmail = defineJob<SendEmailPayload>({ queue: 'default', handler: () => {} })
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used below via `typeof archive`, a type-only reference
const archive = defineJob({
  input: z.object({ id: z.string().transform(Number) }),
  handler: () => {},
})

interface TestJobMap {
  'send-email': EnqueueInputOf<typeof sendEmail>
  'mail/archive': EnqueueInputOf<typeof archive>
}

declare const queue: TypedQueue<TestJobMap>

describe('typed enqueue', () => {
  it('accepts a correct payload', () => {
    expectTypeOf(queue.enqueue).toBeCallableWith('send-email', { to: 'a@b.c', subject: 'hi' })
  })

  it('accepts an options object', () => {
    expectTypeOf(queue.enqueue).toBeCallableWith(
      'send-email',
      { to: 'a@b.c', subject: 'hi' },
      { delay: 5000 },
    )
  })

  // eslint-disable-next-line vitest/expect-expect -- the @ts-expect-error below IS the assertion; there is no runtime expectTypeOf call to make
  it('rejects an unknown job name', () => {
    // @ts-expect-error 'send-emial' is not a key of the job map
    queue.enqueue('send-emial', { to: 'a@b.c', subject: 'hi' })
  })

  // eslint-disable-next-line vitest/expect-expect -- the @ts-expect-error below IS the assertion; there is no runtime expectTypeOf call to make
  it('rejects a payload with a wrong field type', () => {
    // @ts-expect-error `to` is a string
    queue.enqueue('send-email', { to: 1, subject: 'hi' })
  })

  // eslint-disable-next-line vitest/expect-expect -- the @ts-expect-error below IS the assertion; there is no runtime expectTypeOf call to make
  it('rejects a payload missing a required field', () => {
    // @ts-expect-error `subject` is required
    queue.enqueue('send-email', { to: 'a@b.c' })
  })

  it('types a schema-backed job by its INPUT, not its output', () => {
    expectTypeOf(queue.enqueue).toBeCallableWith('mail/archive', { id: '42' })
  })

  // eslint-disable-next-line vitest/expect-expect -- the @ts-expect-error below IS the assertion; there is no runtime expectTypeOf call to make
  it('rejects the schema OUTPUT on the enqueue side', () => {
    // The transform runs in the worker. Accepting a number here would mean
    // the producer sent something the consumer's z.string() must reject.
    // @ts-expect-error `id` is a string on the enqueue side
    queue.enqueue('mail/archive', { id: 42 })
  })

  it('narrows the name parameter to a literal union', () => {
    expectTypeOf<Parameters<typeof queue.enqueue>[0]>()
      .toEqualTypeOf<'send-email' | 'mail/archive'>()
  })
})

// A cron job is an ordinary map member with its payload type intact — which is
// what makes dashboard run-now an `enqueue` call rather than a second write
// path. Declaring `cron` must not collapse the payload to `unknown`, which is
// exactly what would happen if the new option disturbed EnqueueInputOf's
// two-parameter inference.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used below via `typeof digest`, a type-only reference
const digest = defineJob({
  input: z.object({ scope: z.string() }),
  cron: { expression: '0 9 * * MON', payload: { scope: 'weekly' } },
  handler: () => {},
})

expectTypeOf<EnqueueInputOf<typeof digest>>().toEqualTypeOf<{ scope: string }>()
