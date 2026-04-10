import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['compiler/src/__tests__/**/*.test.ts', 'runtime/src/__tests__/**/*.test.ts'],
  },
})
