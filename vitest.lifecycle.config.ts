import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/lifecycle/**/*.test.ts'],
    globalSetup: ['test/lifecycle/globalSetup.ts'],
    // These spawn real processes on shared ports and shared Redis keys.
    fileParallelism: false,
    hookTimeout: 320_000,
    testTimeout: 120_000,
  },
})
