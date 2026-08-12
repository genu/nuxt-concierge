import { describe, it, expect, vi } from 'vitest'
import fg from 'fast-glob'
import { scanJobs, jobNameFromPath } from '../../src/scan'

vi.mock('@nuxt/kit', () => ({
  useNuxt: () => ({ options: { rootDir: '/repo' } }),
}))

vi.mock('fast-glob', () => ({
  default: vi.fn(),
}))

describe('jobNameFromPath', () => {
  it('keeps a flat filename unchanged', () => {
    expect(jobNameFromPath('/repo/server/jobs/send-email.ts', '/repo/server/jobs')).toBe('send-email')
  })

  it('keeps the subdirectory for a nested job, so it does not collide on basename alone', () => {
    expect(jobNameFromPath('/repo/server/jobs/mail/send.ts', '/repo/server/jobs')).toBe('mail/send')
  })
})

describe('scanJobs', () => {
  it('names a flat job by its filename', async () => {
    vi.mocked(fg).mockResolvedValue(['/repo/server/jobs/send-email.ts'])

    expect(await scanJobs()).toEqual([
      { file: '/repo/server/jobs/send-email.ts', name: 'send-email' },
    ])
  })

  it('names a nested job by its path relative to server/jobs', async () => {
    vi.mocked(fg).mockResolvedValue(['/repo/server/jobs/mail/send.ts'])

    expect(await scanJobs()).toEqual([
      { file: '/repo/server/jobs/mail/send.ts', name: 'mail/send' },
    ])
  })

  it('throws on two files resolving to the same name, naming both offenders', async () => {
    vi.mocked(fg).mockResolvedValue([
      '/repo/server/jobs/send-email.ts',
      '/repo/server/jobs/send-email.js',
    ])

    await expect(scanJobs()).rejects.toThrow(
      /send-email.*\/repo\/server\/jobs\/send-email\.js.*\/repo\/server\/jobs\/send-email\.ts/s,
    )
  })
})
