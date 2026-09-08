// The STANDALONE tree's vitest config — the mirror repository and a consumer checkout, where
// `bun run test` runs from this directory. Inside the monorepo the same files run from the
// root `vitest.config.ts`, which never reads this one (vitest resolves the config of the
// directory it is invoked from; a nested config is not a project of the root's).
//
// `testTimeout` mirrors the root config's value, and is the reason this file exists: the
// df64 property suites (`src/core/fp64/df64-int-property.test.ts`) sample random inputs for
// 8–16 s per test on a 4-core container, and vitest's 5 s default fails four of them in a
// tree that has no other config to say otherwise (measured 2026-09-07, #2660).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'examples/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
