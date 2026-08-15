import { createHash } from 'node:crypto'
import { encodePayload } from './envelope'
import type { UniqueOptions } from './types'
import type { DedupOptions } from './drivers/types'

/**
 * Job name plus a hash of the SERIALIZED ENVELOPE — the exact devalue string
 * the driver is about to store.
 *
 * Deliberately not an order-insensitive canonical form. One was specified and
 * attempted across three implementation rounds, and each round fixed the cited
 * examples while leaving the mechanism open. The failure is structural: a
 * hand-written canonical form dispatches on `instanceof` and prototype
 * identity, devalue dispatches on the `Object.prototype.toString` brand and on
 * shape, and any value in the gap between those two dispatchers gets devalue's
 * insertion-ordered walk regardless. Escapees found in review: a `URL` subclass
 * carrying its own property (two hrefs, one key — a silently suppressed job),
 * objects whose data is inherited one link up a null-prototype chain, and
 * cross-realm `Map`/`Set`.
 *
 * Hashing the envelope has ONE dispatcher, so the gap cannot exist by
 * construction, and every exotic type devalue supports is distinguished by
 * value for free.
 *
 * The accepted cost: two payloads that serialize differently do not
 * deduplicate, which includes object key order, Map/Set insertion order,
 * whether two equal sub-objects are the same reference or two, and whether a
 * bag was built with `Object.create(null)`. That is the better failure —
 * order sensitivity means deduplication is less effective and the job runs
 * twice, which every handler must already tolerate under at-least-once
 * delivery, whereas the bugs it replaces meant a job was silently suppressed
 * and never ran. `uniqueId` is the escape hatch for payloads assembled from
 * more than one call site.
 *
 * Hashed rather than embedded whole because the id becomes a Redis key suffix,
 * and an unbounded payload would make an unbounded key.
 *
 * A payload devalue cannot serialize throws HERE rather than one line later in
 * `driver.enqueue`, which already calls `encodePayload` on the same value — the
 * same error, the same call site, marginally earlier.
 *
 * Why hashing the STORED form is sound, and not merely convenient: all three
 * drivers round-trip the payload through the envelope before the handler sees
 * it — `bullmq` and `memory` store `encodePayload(...)` and decode on consume,
 * and `sync` does `decodePayload(encodePayload(...))` explicitly even though it
 * never leaves the process. So the hashed string is exactly the string that
 * determines what the handler receives, which makes "same key implies
 * byte-identical delivery" a property of the system rather than an
 * observation. Every case where devalue is lossy — own properties on a branded
 * type, an invalid Date, a RegExp's lastIndex — is loss the suppressed job
 * would have suffered anyway.
 *
 * This depends on the drivers continuing to decode the envelope. A driver that
 * delivered the raw payload object instead would break the argument, not just
 * the optimisation.
 */
export const defaultDedupId = (jobName: string, payload: unknown): string =>
  `${jobName}:${createHash('sha256').update(encodePayload(payload).payload).digest('hex').slice(0, 32)}`

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
 * jobs whose functions both return `"1"` would share one dedup key and suppress
 * each other — a cross-job interaction nobody would predict from reading either
 * job.
 */
export const resolveDedup = (
  { jobName, payload, unique, uniqueId }: ResolveDedupArgs,
): DedupOptions | undefined => {
  if (!unique) return undefined

  const id = uniqueId ? `${jobName}:${uniqueId(payload)}` : defaultDedupId(jobName, payload)

  // `debounce` requires a POSITIVE ttl to mean anything: `extend`/`replace`
  // without an expiry is BullMQ's replace-with-no-expiry branch, which is a
  // lock that keeps moving rather than a debounce window. A `ttl` of 0 (or
  // negative) gives no window at all and lands in exactly that branch, so it
  // is treated the same as an absent one here rather than passed through.
  //
  // `defineJob` rejects the combination at definition time, so this is
  // unreachable from a job written the normal way — but a hand-built registry
  // entry reaches `resolveDedup` directly, and the two must not disagree about
  // what counts as a usable ttl.
  const ttl = typeof unique.ttl === 'number' && unique.ttl > 0 ? unique.ttl : undefined

  if (ttl === undefined) return { id }
  if (unique.debounce) return { id, ttl, extend: true, replace: true }
  return { id, ttl }
}
