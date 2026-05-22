<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/e2e

## Purpose
Playwright end-to-end test suite for the X-GIS playground. Contains ~170 spec files covering smoke/fixture/interaction/reftest suites (stable, run every CI push), plus a large collection of `_`-prefixed investigative specs (pixel-match surveys, performance benchmarks, projection coverage matrices, regression replays, and debug captures). The stable suite is `smoke.spec.ts`, `fixtures.spec.ts`, `interactions.spec.ts`, `reftest.spec.ts`, `animation.spec.ts`, `worldwrap-z0.spec.ts`, and `miter-check.spec.ts`. The `_`-prefixed specs are run on-demand or in dedicated CI workflows.

## Key Files
| File | Description |
|------|-------------|
| `smoke.spec.ts` | Per-demo smoke: 5 curated demos (physical_map_10m, vector_categorical, bucket_order, sdf_points, water_hierarchy). Asserts no console errors, no overlay errors, non-zero canvas pixels, baseline screenshot match. |
| `fixtures.spec.ts` | Per-fixture feature isolation: navigates each `fixture-*` demo, asserts color histogram presence + zero WebGPU validation errors via `withValidationCapture`. |
| `interactions.spec.ts` | Pointer event / layer event / camera API integration tests. |
| `reftest.spec.ts` | Paired reference tests: renders `reftest-*-static.xgis` vs `reftest-*-match.xgis`, asserts `pixelDiffRatio < threshold`. |
| `animation.spec.ts` | Animation continuity tests: captures at `t=0` and `t≈3000ms`, asserts frames differ (animation still cycling). |
| `worldwrap-z0.spec.ts` | World-copy and z=0 render correctness. |
| `miter-check.spec.ts` | Miter-join geometry correctness. |
| `_pixel-match-survey.spec.ts` | Full pixel-match survey: X-GIS vs MapLibre side-by-side across 8+ views, outputs PNG + buckets.json to `__pixel-match-survey__/`. |
| `_pixel-match-user-views.spec.ts` | Pixel-match against user-reported real-world views (Korea, Tokyo, Paris). |
| `_pixel-match-seoul-zoom-matrix.spec.ts` | Seoul zoom/pitch matrix (z0–z19 × p0/p60) pixel-match. |
| `_perf-*.spec.ts` | Performance benchmark specs: p95 frame time, tile counts, cold-start, CPU profile, drag jank. |
| `_projection-coverage.spec.ts` | Renders all 8 projections × zoom levels and asserts non-blank canvas. |
| `_screenshot-non-merc-seoul-matrix.spec.ts` | Screenshot matrix for 5 non-Mercator projections × zoom/pitch combinations. |
| `_demo-audit-report.ts` | `globalTeardown` module — aggregates per-spec pass/fail into a summary report. Not a test spec itself. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `helpers/` | Reusable Playwright helper functions: visual capture/pixel utilities, WebGPU validation capture, scenario loading, natural interaction drivers (see `helpers/AGENTS.md`). |
| `fixtures/` | Static test data: camera-motion scenario JSON files (see `fixtures/AGENTS.md`). |
| `spec-invariants/` | Parameterised invariant specs that run against live render traces to pin camera-state and paint-property resolution contracts (see `spec-invariants/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- All specs target `https://localhost:3000` (Vite dev server must be running, or `reuseExistingServer: true` starts it automatically).
- `__xgisReady` must be awaited before any canvas capture or assertion — use `captureCanvas()` from `helpers/visual.ts`, never `page.waitForTimeout`.
- `window.__xgisMap` exposes the live engine instance; access it via `page.evaluate()` only, never cache across navigation.
- Stable specs (no `_` prefix) must stay green. If a stable spec breaks after your change, fix the production code — do not modify the test assertion.
- `_`-prefixed specs may use `test.skip()` or `test.fixme()` when investigating known-broken states; leave a comment with the tracking note reference.
- Generated output directories (`__*__/`) are skipped by `playwright.config.ts` glob patterns; do not create source files inside them.

### Testing Requirements
- `bun run test:e2e` from `playground/` runs all specs in `testDir: ./e2e`.
- To run a single spec: `bun run test:e2e e2e/smoke.spec.ts`.
- Visual regression baselines: `bun run test:e2e -- --update-snapshots` (requires a working GPU).
- Pixel-match specs require `workers: 1` (set in the spec itself); do not override.
- `HEADED=0` disables headed mode — only set this if a GPU-enabled headless runner is available.

### Common Patterns
- Import visual helpers: `import { captureCanvas, expectPixelAt, colorHistogram } from './helpers/visual'`.
- Import validation helpers: `import { withValidationCapture, clearValidationErrors } from './helpers/validation'`.
- Navigate pattern: `await page.goto('/demo.html?id=<id>', { waitUntil: 'domcontentloaded' })` then `captureCanvas(page)`.
- Performance gate pattern: assert `p95 < 50` and `max < 200` on `FrameTimings.frames` from `natural-interaction.ts`.
- Spec naming: stable suites use plain names (`smoke.spec.ts`); investigative/diagnostic specs use `_` prefix (`_debug-*.spec.ts`, `_perf-*.spec.ts`).

## Dependencies

### Internal
- `helpers/visual.ts` — `captureCanvas`, pixel utilities
- `helpers/validation.ts` — `withValidationCapture`, WebGPU error queue
- `helpers/scenarios.ts` — `loadScenario`, `CameraState`, `Scenario`
- `helpers/natural-interaction.ts` — rAF-driven interaction driver, `FrameTimings`
- `@xgis/runtime` (via playground server)

### External
- `@playwright/test` ^1.59.1
- `pixelmatch` ^7.2.0, `pngjs` ^7.0.0 (pixel-diff specs only)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
