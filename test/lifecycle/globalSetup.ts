import { execSync } from 'node:child_process'
import { namespaceRedisUrl } from './harness'

/**
 * Runs once for the whole lifecycle project, replacing the per-file
 * `beforeAll(() => execSync('pnpm dev:build'))` each file used to carry. That
 * cost grew linearly with every new scenario file and was invisible in a green
 * run — it showed up only as wall-clock time.
 *
 * The REDIS_URL namespacing MUST happen here, before the build reads it, so
 * every consumer (the build, flushRedis, and every spawned app) agrees on the
 * dedicated logical database. flushRedis runs FLUSHDB and refuses to run
 * against database 0.
 */
export default function setup() {
  if (process.env.REDIS_URL) {
    process.env.REDIS_URL = namespaceRedisUrl(process.env.REDIS_URL)
  }
  execSync('pnpm dev:build', { stdio: 'inherit', timeout: 300_000 })
}
