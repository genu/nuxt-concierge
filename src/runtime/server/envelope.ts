import { parse, stringify } from 'devalue'

export const ENVELOPE_VERSION = 1

export interface Envelope {
  v: number
  payload: string
}

/**
 * Thrown when a payload cannot be decoded. Not retryable: retrying a payload
 * this process cannot understand will fail identically every time, so the job
 * must fail once and stay failed rather than crash-loop the worker.
 */
export class UnsupportedEnvelopeError extends Error {
  readonly retryable = false

  constructor(message: string) {
    super(`[nuxt-concierge] ${message}`)
    this.name = 'UnsupportedEnvelopeError'
  }
}

/**
 * devalue `stringify` (NOT `uneval`) — uneval emits JS source requiring eval,
 * which is a deserialization RCE if anything can write to the queue backend.
 * stringify output is JSON-compatible, so BullMQ can store it directly.
 */
export const encodePayload = (payload: unknown): Envelope => ({
  v: ENVELOPE_VERSION,
  payload: stringify(payload),
})

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === 'object'
  && value !== null
  && typeof (value as Envelope).v === 'number'
  && typeof (value as Envelope).payload === 'string'

/**
 * Describes the SHAPE of an unrecognised value, never its content. Job
 * payloads routinely carry user data (emails, IDs, etc.); the bullmq driver
 * turns an UnsupportedEnvelopeError's message into an UnrecoverableError,
 * which BullMQ persists as `failedReason` in Redis and also logs — so
 * anything embedded here leaks into both the queue backend and the log
 * stream. `v` is only reported when it is the expected primitive type
 * (number); anything else is reduced to its `typeof`, never its value, since
 * an attacker-controlled envelope-shaped object could otherwise smuggle
 * arbitrary data into `v` itself.
 */
const describeEnvelopeShape = (value: unknown): string => {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined

  const v = record && 'v' in record
    ? (typeof record.v === 'number' ? String(record.v) : `non-number (${typeof record.v})`)
    : 'absent'
  const payloadLength = record && 'payload' in record
    ? (typeof record.payload === 'string' ? String(record.payload.length) : `not a string (${typeof record.payload})`)
    : 'absent'

  return `type=${type}, looksLikeEnvelope=${isEnvelope(value)}, v=${v}, payloadLength=${payloadLength}`
}

export const decodePayload = (envelope: unknown): unknown => {
  if (!isEnvelope(envelope)) {
    throw new UnsupportedEnvelopeError(
      `Job payload is not a concierge envelope (${describeEnvelopeShape(envelope)})`,
    )
  }

  if (envelope.v !== ENVELOPE_VERSION) {
    throw new UnsupportedEnvelopeError(
      `Cannot decode envelope version ${envelope.v}; this build understands version ${ENVELOPE_VERSION}. `
      + `This usually means a deploy changed the payload format while older jobs were still queued.`,
    )
  }

  try {
    return parse(envelope.payload)
  }
  catch (err) {
    // `err.message` is NOT used here: devalue/JSON.parse failures quote the
    // offending text back verbatim (e.g. `Unexpected token 'o', "the-actual-
    // payload" is not valid JSON`), which would smuggle payload content
    // straight through this catch — the exact leak `describeEnvelopeShape`
    // exists to avoid for a malformed envelope. `err.name` is a fixed string
    // from a closed set (SyntaxError, RangeError, …), never derived from the
    // input, so it is safe to report.
    const kind = err instanceof Error ? err.name : typeof err
    throw new UnsupportedEnvelopeError(
      `Envelope payload could not be decoded (payloadLength=${envelope.payload.length}, cause=${kind}). `
      + `This usually means the encoded payload does not match the format devalue.stringify produces.`,
    )
  }
}
