import { basename } from 'node:path'
import fg from 'fast-glob'
import { useNuxt } from '@nuxt/kit'

export const JOBS_DIR = 'server/jobs'

/**
 * Scans <rootDir>/server/jobs.
 *
 * rootDir, NOT srcDir: in Nuxt 4 srcDir defaults to `app/`, so resolving
 * against it yields `app/server/jobs`, which does not exist — the scan finds
 * nothing and no error is raised. server/ lives at rootDir in both v3 and v4.
 * Credit: PR #10 by @gsxdsm.
 */
export const scanJobs = async (): Promise<string[]> => {
  const nuxt = useNuxt()
  const cwd = `${nuxt.options.rootDir}/${JOBS_DIR}`

  const files = await fg('**/*.{ts,js,mjs}', { cwd, absolute: true, onlyFiles: true })
  return [...new Set(files)].sort()
}

/** `server/jobs/send-email.ts` -> `send-email` */
export const jobNameFromPath = (path: string): string =>
  basename(path).replace(/\.(ts|js|mjs)$/, '')
