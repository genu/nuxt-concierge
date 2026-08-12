import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/*.test.ts'],
    exclude: ['test/lifecycle/**'],
  },
})
