import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultExclude, defineConfig } from 'vitest/config'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

// ── Why this file has three modes ───────────────────────────────────────────
//
// MEASURED on this tree (4-core container, 1411 files / 12230 tests): the suite
// costs 7m26s under vitest's default per-file isolation and 2m16s without it.
// The 5m10s is NOT test execution — that is ~265s either way. It is the per-FILE
// tax isolation charges for re-entering the module graph 1411 times:
//   setup 238s → 4s   collect 429s → 74s   prepare 107s → 0.8s
// A shared registry pays that tax once per WORKER instead of once per file.
//
// It cannot simply be turned on for everything. A shared registry is exactly
// what `vi.mock` needs NOT to have: `map/src/coverage-source-refresh.test.ts`
// mocks `@xgis/data`, and when a sibling file in the same worker has already
// imported the real one the mock does not take — the spec then drives the REAL
// HDF5 reader and dies on `not an HDF5 file`. The same applies to the handful of
// suites whose subject IS a pristine process global (`activeBody()` read before
// anyone configures it). Those files keep one fresh registry each.
//
// So: XGIS_VITEST_MODE selects which half runs.
//   'shared'   — everything EXCEPT `ISOLATED`, one registry per worker.
//   'isolated' — exactly `ISOLATED`, vitest's default per-file isolation.
//   unset      — EVERYTHING, isolated, i.e. byte-for-byte the pre-split gate.
// The unset mode is load-bearing, not a leftover: `vitest run <args>` is what CI
// invokes (test.yml's matrix legs) and what a developer types by reflex, and it
// must stay the whole suite under the old semantics. `bun run test` and
// `bun precheck` go through scripts/vitest-run.ts, which runs both halves.
const MODE = process.env.XGIS_VITEST_MODE ?? ''

// The single authority for what the unit suite covers. EXPORTED so
// scripts/isolated-closure.test.ts can gate rule (1) below against the very same
// array, rather than re-deriving the corpus and becoming a second authority.
export const INCLUDE = [
  'shared/src/**/*.test.ts',
  'geo/src/**/*.test.ts',
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
  'pipeline/src/**/*.test.ts',
  // Dev-tooling + demo-logic unit tests (the NOAA CORS proxy; the S-111 model
  // registry). The CI matrix shards vitest by package path arg (none cover
  // playground/), so these run in a full local `vitest run` — they do NOT change any
  // CI leg's file set.
  'playground/dev/**/*.test.ts',
  'playground/src/**/*.test.ts',
  // The e2e HELPERS' own unit tests (#2231). Only `helpers/**/*.test.ts` — the
  // ~350 Playwright specs beside them are `.spec.ts` and stay out of vitest.
  // `awaitMapIdle`'s decision lives there because it cannot be witnessed
  // end-to-end: the helper is a `page.evaluate`, and the CDP round-trip outlasts
  // the one-tick staleness window the test has to observe.
  'playground/e2e/helpers/**/*.test.ts',
  // Repo-tooling unit tests (the changelog generator). CI-covered by the
  // `data` leg (test.yml passes `data/src scripts`); the spawned git probes
  // in the suite self-skip on CI's depth-1 checkout. Co-located with the
  // script deliberately — the alternative (parking the test inside a
  // package's src/) would put a scripts/ import inside that package's
  // tsconfig rootDir and break its `tsc --build`.
  'scripts/**/*.test.ts',
]

// ── The files that must keep their own registry ─────────────────────────────
//
// Membership is by CLASS, not by "it went red once". Which file a shared
// registry actually breaks depends on how the pool packs files into workers, so
// admitting only the observed casualties leaves the rest to fail at random on
// some later run — and a gate that is red at random trains people to ignore it
// (§12). Four rules, each mechanical over `--include=*.test.ts`, each admitting
// its whole set:
//
//   (1) `vi\.mock\(|vi\.doMock\(` — module mocking is a statement ABOUT a
//       registry, so it needs one it owns. Measured casualty:
//       `map/src/coverage-source-refresh.test.ts` mocks `@xgis/data`, and when a
//       sibling in the same worker has already imported the real one the mock
//       does not take — the spec then drives the REAL HDF5 reader and dies on
//       `not an HDF5 file`.
//
//   (2) process-global writers and the suites that read a global's pristine
//       default: `vi\.stubGlobal\(`, an assignment onto `globalThis`, or a write
//       through one of the authorities that keeps its state there —
//       `configureBody`, `configureBodyConsts`, `configureProjections`,
//       `setLogSink`. Measured casualties: `shared/src/body.test.ts` (its
//       subject IS `activeBody()` on "an unconfigured process") and
//       `rhi-webgpu/src/device-lost-recovery.test.ts` (a swapped
//       `navigator.gpu`, which timed out at 30s when it was left shared).
//
//   (3) the two suites that assert a WALL-CLOCK threshold
//       (`merc-high-pitch-drag-perf`, `pbf-to-slot-dos`). A shared worker holds
//       the whole run's live heap, so GC pressure lands on exactly the number
//       they gate on; measured, `p95 < 20` came back 23.5.
//
//   (4) ALL of `rhi-webgpu/src` — the package, not a file list. What its suites
//       drive is a process-wide singleton: the memoized backend-provider chain,
//       device ownership, the validation-error cap, `navigator.gpu` itself. Two
//       of them were admitted one at a time under rules (1)-(2) and a THIRD
//       (`webgl2-context-loss`, a 30s timeout on a fake canvas that never got
//       its event) came back on a later run, which is the tell that the class is
//       the package. A new device-lifecycle suite lands inside the glob rather
//       than joining that queue.
//
// A file that needs isolation and matches none of the four goes red in the
// shared pass — loudly, naming state it never set. Add it here with its reason.
//
// This is a PATH-KEYED list, the shape §12 records dying silently when files
// move (two ratchets sat vacuously green that way). The `globSync` guard below
// is its companion assertion: an entry that matches nothing fails the config
// load instead of quietly quarantining nothing — which covers a moved FILE and
// an emptied DIRECTORY alike.
export const ISOLATED = [
  // (4) the whole @xgis/rhi-webgpu suite — see the rule above.
  'rhi-webgpu/src/**/*.test.ts',
  // (2) engine's GPU quality flags read off `globalThis.location`.
  'engine/src/gpu/quality-url-flags.test.ts',
  'data/src/bandwidth-link-budgets.test.ts',
  'data/src/hdf5/bbox-window.test.ts',
  'data/src/hdf5/range-reader.test.ts',
  'data/src/source-resolve-error-report.test.ts',
  'data/src/sources/pmtiles-backend.test.ts',
  'data/src/sources/virtual-pmtiles-teardown.test.ts',
  // (1) module mock — geojson-tiling-pool + mvt-worker-pool, so the worker compile arm
  //     can be held open mid-flight (#2359).
  'data/src/sources/virtual-pmtiles-worker-detach.test.ts',
  'data/src/tile-catalog-layout-version-eviction.test.ts',
  'data/src/tile-select-budget.test.ts',
  'data/src/vector-tile-loader-negcache-abort.test.ts',
  // (2) swaps `globalThis.fetch` AND `globalThis.setTimeout` — the retry clock is the
  //     subject, so a sibling holding the real timer defeats the whole file.
  'data/src/vector-tile-loader-retry-jitter.test.ts',
  'data/src/viewport-class-budget-migration.test.ts',
  'data/src/workers/geojson-compile-pool-isolation.test.ts',
  'data/src/workers/geojson-compile-pool.error.test.ts',
  'data/src/workers/geojson-tiling-pool-isolation.test.ts',
  'data/src/workers/geojson-tiling-pool-respawn.test.ts',
  'data/src/workers/geojson-tiling-worker-isolation.test.ts',
  'data/src/workers/mvt-worker-pool-cold-start-burst.test.ts',
  'data/src/workers/mvt-worker-pool-dispose.test.ts',
  'data/src/workers/mvt-worker-pool-drain-throttled.test.ts',
  'data/src/workers/mvt-worker-pool.error.test.ts',
  'map/src/__profile__/perf-marks.test.ts',
  'map/src/__tests__/event-dispatcher-hover-cursor.test.ts',
  // (2) the FOURTH `event-dispatcher-*` suite. The three listed around it stub the
  //     same `requestAnimationFrame` / `cancelAnimationFrame` pair through a
  //     near-identical `installMockRaf()`; this one was simply missed. Measured
  //     casualty: two 30 s timeouts in its OWN tests, in the SHARED pass, on 3 of 3
  //     full sweeps, while it passes alone in 9 ms (#2567).
  'map/src/__tests__/event-dispatcher-leave-inflight-pick.test.ts',
  'map/src/__tests__/event-dispatcher-leave-raf-cancel.test.ts',
  'map/src/__tests__/event-dispatcher-listener-gate.test.ts',
  'map/src/arrow-show.test.ts',
  'map/src/bandwidth-link-prefetch.test.ts',
  'map/src/body-blind-caches.test.ts',
  'map/src/body-consts.test.ts',
  'map/src/body-option.test.ts',
  'map/src/camera-controller-api-validation.test.ts',
  'map/src/camera-dpr-units.test.ts',
  'map/src/continent-match-compute-mock.test.ts',
  'map/src/controller-cooperative-gestures.test.ts',
  'map/src/controller-dblclick-boxzoom.test.ts',
  'map/src/controller-dpr-anchor.test.ts',
  // (2) assigns `globalThis.window` and writes QUALITY via updateQuality (interaction-dpr anchor fix).
  'map/src/controller-interaction-dpr-anchor.test.ts',
  'map/src/controller-interaction-gate.test.ts',
  'map/src/coverage-abort-spine.test.ts',
  'map/src/coverage-catalogue.test.ts',
  'map/src/coverage-residency-driver.test.ts',
  'map/src/coverage-source-refresh.test.ts',
  'map/src/coverage-source.test.ts',
  'map/src/coverage-step-atomic.test.ts',
  'map/src/debug-flags.test.ts',
  'map/src/destroy-raf-and-globals.test.ts',
  'map/src/graphics/retained-draper-laziness.test.ts',
  'map/src/map-accessibility.test.ts',
  'map/src/map-cold-start-burst-lifecycle.test.ts',
  'map/src/map-destroy.test.ts',
  'map/src/map-error-event.test.ts',
  'map/src/map-hash-sync.test.ts',
  // (1) `vi.mock('@xgis/data', …)` for the shared GeoJSON compile pool. Landed in
  //     #1837/#1940 without joining this list, which left it green only for as long as
  //     the pool happened to pack it ahead of every sibling that imports the real
  //     @xgis/data — exactly the fail-at-random the rule above exists to prevent. It
  //     came due when an UNRELATED shader-dsl spec grew by two cases (#1903).
  'map/src/map-inline-geojson-route.test.ts',
  'map/src/map-polar-cap-deprecation.test.ts',
  'map/src/map-rebuild-layers.characterization.test.ts',
  // (2) SECOND clause — "the suites that read a global's pristine default". It writes
  //     nothing and mocks nothing, so the mechanical half of the rule cannot see it; it is
  //     admitted by hand as a MEASURED casualty, the way its `rhi-webgpu` namesake was.
  //     Surfaced when the seven entries above left the shared pass and the pool repacked:
  //     two tests hung to the 30 s budget, and the file passes ALONE in 24 ms.
  'map/src/map-device-lost-recovery.test.ts',
  'map/src/map-run-epoch-lifecycle.test.ts',
  'map/src/overdraw-picking-caps-correction.test.ts',
  'map/src/p0-quartet.test.ts',
  'map/src/render-loop-helpers.report-error-scope.test.ts',
  'map/src/render-loop-interaction-dpr.test.ts',
  'map/src/render/back-face-cull-comprehensive.test.ts',
  'map/src/render/compute-layer-handle.test.ts',
  'map/src/render/compute-layer-registry.test.ts',
  // (2) `setLogSink` — one of the four authorities rule (2) names by hand.
  'map/src/render/feature-data-sparse-fid.test.ts',
  'map/src/render/frame-uniform.test.ts',
  'map/src/render/hillshade-loadtile-rhi.test.ts',
  'map/src/render/maprenderer-uniform-bind-size.test.ts',
  'map/src/render/material/glsl-stage-entry-parity.test.ts',
  'map/src/render/material/hillshade-glsl-stages-parity.test.ts',
  'map/src/render/merc-high-pitch-drag-perf.test.ts',
  'map/src/render/no-eager-uniform-reflect.test.ts',
  'map/src/render/p4-end-to-end.test.ts',
  // (2) swaps `globalThis.fetch` to serve its DEM tiles.
  'map/src/render/passes/hillshade-pass-pick-attachment-parity.test.ts',
  'map/src/render/passes/opaque-pass-checker-arm.test.ts',
  'map/src/render/passes/overdraw-frame-truth.test.ts',
  // (2) `configureBody` + `configureBodyConsts` — the same process-global pair
  //     #2567/#2590 are about, and `vitest.setup.ts`'s leak guard watches.
  'map/src/render/polygon-shader-cache-baked.test.ts',
  'map/src/render/raster-abort-not-failure.test.ts',
  'map/src/render/raster-cache-byte-cap.test.ts',
  'map/src/render/raster-loadtile-webgl2-cleanup.test.ts',
  'map/src/render/raster-tile-retry-storm.test.ts',
  'map/src/render/renderer-compute-simulation.test.ts',
  'map/src/render/renderer-stub-construction.test.ts',
  // (2) `configureBody` — it switches the process-global body to MOON / MARS to
  //     witness #2564 and restores EARTH in afterEach.
  'map/src/render/tile-camera-anchor-body.test.ts',
  'map/src/render/tile-compute-resources.test.ts',
  'map/src/render/vector-drape-bake-budget.test.ts',
  // (2) stubs `window` and `matchMedia`.
  'map/src/render/vector-drape-cold-release.test.ts',
  'map/src/render/vector-tile-renderer-helpers.test.ts',
  'map/src/render/viewport-class-budget-behaviour.test.ts',
  'map/src/render/vtr-bundle-compaction-invalidate.test.ts',
  'map/src/render/vtr-destroy-resource-release.test.ts',
  'map/src/render/wire-frame-colour-overdraw-cap.test.ts',
  'map/src/safety-ssrf-integration.test.ts',
  'map/src/shaders/baked/baked-body-guard.test.ts',
  'map/src/shaders/baked/baked-sync.test.ts',
  'map/src/shaders/baked/boot-install-order.test.ts',
  'map/src/shaders/baked/ids.test.ts',
  'map/src/shaders/baked/install.test.ts',
  'map/src/shaders/baked/seed-hillshade.test.ts',
  'map/src/shaders/baked/store.test.ts',
  'map/src/shaders/dsl/validate.test.ts',
  'map/src/shaders/emit/shader-emit-pool-failure.test.ts',
  'map/src/shaders/emit/shader-emit-pool.test.ts',
  'map/src/source-manager-drop-tiling.test.ts',
  'map/src/source-manager-refresh.test.ts',
  // (2) stubs `requestAnimationFrame` / `cancelAnimationFrame` — the SAME pair whose
  //     absence from this list cost #2567's 30 s timeouts — plus `Worker`.
  'map/src/sprite-atlas-rerun-latch.test.ts',
  'map/src/stats-byte-telemetry.test.ts',
  'map/src/text/sdf/pbf/glyph-pbf-cache-warning.test.ts',
  // (2) assigns `globalThis.HTMLElement` before dynamically importing component.ts,
  //     which binds its DOM base class at module load — a shared registry that has
  //     already imported that module hands the class the REAL base and the fake
  //     `attachShadow` never applies (#2327).
  'map/src/web/component.test.ts',
  'map/src/text/sdf/pbf/pbf-to-slot-dos.test.ts',
  // (2) globalThis write — the fake Playwright page points `globalThis.window` at the
  //     realm under test for the duration of each `evaluate` (#2352).
  'playground/e2e/helpers/validation.test.ts',
  // (2) stubs `document`, `window` and `Image`.
  'playground/src/overdraw-capture.test.ts',
  'shared/src/body.test.ts',
  'shared/src/network-class.test.ts',
  'shared/src/safety.test.ts',
  'shared/src/viewport-class.test.ts',
]

const barren = ISOLATED.filter((f) => globSync(f, { cwd: ROOT }).length === 0)
if (barren.length > 0) {
  throw new Error(
    `vitest.config.ts: ${barren.length} ISOLATED entr(ies) match no file:\n` +
      barren.map((f) => `  - ${f}`).join('\n') +
      `\nAn entry that matches nothing quarantines nothing — re-point it or drop it.`,
  )
}

export default defineConfig({
  test: {
    include: MODE === 'isolated' ? ISOLATED : INCLUDE,
    // `defaultExclude` is spread back in on purpose — assigning `exclude`
    // REPLACES vitest's defaults, and dropping them would walk node_modules.
    exclude: MODE === 'shared' ? [...defaultExclude, ...ISOLATED] : defaultExclude,
    // shader-dsl projections are host-injected (configureProjections); configure
    // once before any suite touches the projection emit / cpu-projection path.
    setupFiles: ['./vitest.setup.ts'],
    // Several real-data tests (tile-cross-path-invariants /
    // tile-pitch-throughput / tile-real-data-coverage) load the
    // 250-feature Natural Earth `countries.geojson` and run the full
    // compile pipeline. Vitest's 5s default fires before they finish
    // on a cold worker. 30s mirrors the existing Playwright spec
    // timeout convention and matches bun test's observed runtime.
    testTimeout: 30_000,
    // Only the shared pass changes pool semantics. `pool: 'threads'` is a
    // consequence of dropping isolation, not the win: with isolation ON the two
    // pools measure the same (57.9s forks vs 56.5s threads over one 130-file
    // shard). Threads simply start a shared registry cheaper.
    ...(MODE === 'shared' ? ({ pool: 'threads', isolate: false } as const) : {}),
  },
})
