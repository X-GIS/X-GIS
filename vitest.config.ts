import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['compiler/src/**/*.test.ts', 'runtime/src/**/*.test.ts'],
  },
})
