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

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value)?.slice(0, 200) ?? 'unknown'
  }
  catch {
    return String(value).slice(0, 200)
  }
}

export const decodePayload = (envelope: unknown): unknown => {
  if (!isEnvelope(envelope)) {
    throw new UnsupportedEnvelopeError(
      `Job payload is not a concierge envelope: ${safeStringify(envelope)}`,
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
    throw new UnsupportedEnvelopeError(
      `Envelope payload could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
