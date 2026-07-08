import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'shared/src/**/*.test.ts',
      'compiler/src/**/*.test.ts',
      'blueprint/src/**/*.test.ts',
      'shader-dsl/src/**/*.test.ts',
      'shader-dsl/examples/**/*.test.ts',
      'engine/src/**/*.test.ts',
      'rhi/src/**/*.test.ts',
      'rhi-webgl2/src/**/*.test.ts',
      'rhi-webgpu/src/**/*.test.ts',
      'data/src/**/*.test.ts',
      'map/src/**/*.test.ts',
      'runtime/src/**/*.test.ts',
      'pipeline/src/**/*.test.ts',
    ],
    // shader-dsl projections are host-injected (configureProjections); configure
    // once before any suite touches the projection emit / cpu-projection path.
    setupFiles: ['./runtime/src/test-setup-projections.ts'],
    // Several real-data tests (tile-cross-path-invariants /
    // tile-pitch-throughput / tile-real-data-coverage) load the
    // 250-feature Natural Earth `countries.geojson` and run the full
    // compile pipeline. Vitest's 5s default fires before they finish
    // on a cold worker. 30s mirrors the existing Playwright spec
    // timeout convention and matches bun test's observed runtime.
    testTimeout: 30_000,
  },
})
