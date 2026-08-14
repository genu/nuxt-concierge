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
 * The accepted cost: object key order affects the key, so two call sites
 * building the same logical payload in different orders will not deduplicate
 * against each other. That is the better failure — order sensitivity means
 * deduplication is less effective and the job runs twice, which every handler
 * must already tolerate under at-least-once delivery, whereas the bugs it
 * replaces meant a job was silently suppressed and never ran. `uniqueId` is the
 * escape hatch for payloads assembled from more than one call site.
 *
 * Hashed rather than embedded whole because the id becomes a Redis key suffix,
 * and an unbounded payload would make an unbounded key.
 *
 * A payload devalue cannot serialize throws HERE rather than one line later in
 * `driver.enqueue`, which already calls `encodePayload` on the same value — the
 * same error, the same call site, marginally earlier.
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

  // `debounce` requires a ttl to mean anything: `extend`/`replace` without one
  // is BullMQ's replace-with-no-expiry branch, which is a lock that keeps
  // moving rather than a debounce. Resolution drops it rather than emitting a
  // combination nobody asked for; Task 4 rejects it at definition time, so this
  // branch is unreachable from a real job.
  if (unique.ttl === undefined) return { id }
  if (unique.debounce) return { id, ttl: unique.ttl, extend: true, replace: true }
  return { id, ttl: unique.ttl }
}
