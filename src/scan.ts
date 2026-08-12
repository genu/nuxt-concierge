import { relative } from 'node:path'
import fg from 'fast-glob'
import { useNuxt } from '@nuxt/kit'

export const JOBS_DIR = 'server/jobs'

export interface ScannedJob {
  file: string
  name: string
}

/**
 * Scans <rootDir>/server/jobs.
 *
 * rootDir, NOT srcDir: in Nuxt 4 srcDir defaults to `app/`, so resolving
 * against it yields `app/server/jobs`, which does not exist — the scan finds
 * nothing and no error is raised. server/ lives at rootDir in both v3 and v4.
 * Credit: PR #10 by @gsxdsm.
 *
 * Owns both naming and duplicate detection, because Task 8 builds its
 * name -> queue route map directly from this list: the source of truth for
 * "what is this job called" has to live in one place.
 */
export const scanJobs = async (): Promise<ScannedJob[]> => {
  const nuxt = useNuxt()
  const dir = `${nuxt.options.rootDir}/${JOBS_DIR}`

  const files = await fg('**/*.{ts,js,mjs}', { cwd: dir, absolute: true, onlyFiles: true })
  const jobs = [...new Set(files)]
    .sort()
    .map(file => ({ file, name: jobNameFromPath(file, dir) }))

  const filesByName = new Map<string, string[]>()
  for (const job of jobs) {
    filesByName.set(job.name, [...(filesByName.get(job.name) ?? []), job.file])
  }

  for (const [name, collidingFiles] of filesByName) {
    if (collidingFiles.length > 1) {
      throw new Error(
        `[nuxt-concierge] two jobs resolve to the name "${name}": `
        + `${collidingFiles.join(', ')}. Rename one of the files so each job `
        + `under ${JOBS_DIR} has a unique path.`,
      )
    }
  }

  return jobs
}

/**
 * `server/jobs/send-email.ts` -> `send-email`
 * `server/jobs/mail/send.ts` -> `mail/send`
 *
 * The name is the file's path relative to `baseDir` (server/jobs), minus its
 * extension — not just the basename. Basename alone collides across
 * subdirectories (`mail/send.ts` and `sms/send.ts` would both be "send")
 * with nothing to catch it; a relative path mirrors how Nuxt names
 * components and server routes, and flat files are unaffected.
 */
export const jobNameFromPath = (path: string, baseDir: string): string =>
  relative(baseDir, path)
    .replace(/\.(ts|js|mjs)$/, '')
    .split('\\')
    .join('/')
