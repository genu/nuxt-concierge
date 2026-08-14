import { createHash } from 'node:crypto'
import { stringify } from 'devalue'
import type { UniqueOptions } from './types'
import type { DedupOptions } from './drivers/types'

/**
 * A deterministic string form of a payload, insensitive to object key
 * insertion order and to Map/Set iteration order.
 *
 * This exists because the DEFAULT dedup key is derived from the payload, and
 * JS object key order is insertion-ordered — `devalue.stringify({a,b})` and
 * `devalue.stringify({b,a})` produce different strings for the same logical
 * value. Two call sites building the same payload in different orders would
 * therefore fail to deduplicate, in a way that passes every end-to-end test
 * written by one author and fails under production's mix of call sites.
 *
 * Deliberately NOT devalue: devalue's job is round-tripping fidelity, and its
 * output is order-preserving by design. This is a one-way canonical encoding
 * with a different goal. It never needs to be parsed back.
 *
 * Every branch emits a TYPE TAG, so `{a:1}` and `{a:'1'}` cannot collide and
 * an absent key cannot equal an explicit `undefined`.
 */
export const canonicalize = (value: unknown): string => {
  if (value === null) return 'z'
  if (value === undefined) return 'u'

  switch (typeof value) {
    case 'string': return `s:${value.length}:${value}`
    case 'number': return `n:${Object.is(value, -0) ? '-0' : String(value)}`
    case 'boolean': return `b:${value ? 1 : 0}`
    case 'bigint': return `i:${value}`
    // A function or symbol in a payload cannot survive serialisation anyway;
    // encoding it as a fixed tag keeps this total rather than throwing on a
    // value the enqueue path is about to reject for other reasons.
    case 'function':
    case 'symbol': return 'x'
  }

  if (value instanceof Date) return `d:${value.getTime()}`
  // devalue round-trips RegExp natively, so it is a payload type a user can
  // genuinely enqueue. It gets a real encoding rather than falling through to
  // the object branch below, where `Object.entries(/abc/)` is `[]` and every
  // regex would canonicalize identically to `{}`.
  if (value instanceof RegExp) return `r:${canonicalize(value.source)}:${value.flags}`
  if (value instanceof Map) {
    // Sorted by the CANONICAL FORM of each entry, not by the raw key: a Map
    // may be keyed by objects, which have no meaningful `<` ordering.
    return `m:[${[...value.entries()].map(([k, v]) => `${canonicalize(k)}=${canonicalize(v)}`).sort().join(',')}]`
  }
  if (value instanceof Set) {
    return `t:[${[...value].map(canonicalize).sort().join(',')}]`
  }
  if (Array.isArray(value)) {
    // NOT sorted. Array order is semantic — [1,2] and [2,1] are different
    // payloads and must produce different keys.
    return `a:[${value.map(canonicalize).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${canonicalize(k)}=${canonicalize(v)}`)
    .sort()

  const proto = Object.getPrototypeOf(value)
  if (proto === Object.prototype || proto === null) return `o:{${entries.join(',')}}`

  // A non-plain object. The BRAND alone is not enough: a type whose data lives
  // in internal slots rather than own enumerable properties — URL,
  // URLSearchParams, a boxed primitive — has no entries at all, so every
  // instance of it would share one string. That was this module's original
  // defect, found again one type-family later.
  //
  // devalue is this project's serializer and therefore the authority on what a
  // payload can even contain, so its own output is the value encoding here.
  // The types it supports are exactly the types that can reach a queue, and
  // for these leaf types its output is deterministic — there is no key
  // ordering to vary, and every ordered container (Map, Set, Array, plain
  // object) was handled by a branch above and never reaches this line.
  //
  // devalue throws on an arbitrary non-POJO (an Error, a class instance).
  // Such a payload cannot be enqueued at all, so its encoding cannot cause a
  // real collision — the brand plus canonicalized entries is a safe last
  // resort, and it keeps this function total rather than throwing at enqueue.
  const brand = Object.prototype.toString.call(value)
  try {
    return `c:${brand}:${stringify(value)}`
  }
  catch {
    return `c:${brand}:{${entries.join(',')}}`
  }
}

/**
 * Job name plus a hash of the canonical payload — matching Sidekiq's
 * class+args and Oban's worker+args. For a cron job with no payload this
 * reduces to the name plus the hash of `undefined`, which is stable.
 *
 * Hashed rather than embedded whole because the id becomes a Redis key
 * suffix, and an unbounded payload would make an unbounded key.
 */
export const defaultDedupId = (jobName: string, payload: unknown): string =>
  `${jobName}:${createHash('sha256').update(canonicalize(payload)).digest('hex').slice(0, 32)}`

export interface ResolveDedupArgs {
  jobName: string
  payload: unknown
  unique?: UniqueOptions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the registry holds jobs of every payload type; the call site has already validated this payload against the job's own schema.
  uniqueId?: (payload: any) => string
}

/**
 * Turns a job's declared policy into the driver-facing option, or `undefined`
 * when the job declares none.
 *
 * A user-supplied `uniqueId` is always NAMESPACED by job name. Without it, two
 * jobs whose functions both return `"1"` would share one dedup key and
 * suppress each other — a cross-job interaction nobody would predict from
 * reading either job.
 */
export const resolveDedup = (
  { jobName, payload, unique, uniqueId }: ResolveDedupArgs,
): DedupOptions | undefined => {
  if (!unique) return undefined

  const id = uniqueId ? `${jobName}:${uniqueId(payload)}` : defaultDedupId(jobName, payload)

  // `debounce` requires a ttl to mean anything: `extend`/`replace` without one
  // is BullMQ's replace-with-no-expiry branch, which is a lock that keeps
  // moving rather than a debounce. Resolution drops it rather than emitting a
  // combination whose behaviour nobody asked for; Task 4 rejects the config at
  // boot so this branch is unreachable from a real job.
  if (unique.ttl === undefined) return { id }
  if (unique.debounce) return { id, ttl: unique.ttl, extend: true, replace: true }
  return { id, ttl: unique.ttl }
}
