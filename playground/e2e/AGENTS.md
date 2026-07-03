<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# playground/e2e

## Purpose

Playwright end-to-end test suite for the X-GIS playground. Stable specs (no `_` prefix) cover the core render/interaction/animation surface and must stay green on every CI push. Over 100 `_`-prefixed investigative specs cover pixel-match surveys, performance benchmarks, projection matrices, PMTiles load paths, picking, layer events, and debug captures — these run on-demand or in dedicated workflows. Output directories (`__*__/`) hold screenshots and JSON reports from investigative runs.

## Key Files

| File                            | Description                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.ts`                 | Per-demo smoke for 5 curated demos (`physical_map_10m`, `vector_categorical`, `bucket_order`, `sdf_points`, `water_hierarchy`). Four phases per demo: navigate+ready, console/overlay error check, baseline screenshot match, Bug-2 non-background pixel sample for point demos.                                  |
| `fixtures.spec.ts`              | Per-fixture feature isolation: geometry, style, animation, SDF points, projection, stress, caps/joins, stroke patterns, data-driven expressions, custom shapes, external data injection (`setSourceData`/`setSourcePoints`). Uses `withValidationCapture` + color histogram assertions.                           |
| `interactions.spec.ts`          | Curated risk-matrix interaction fixtures: translucent stroke + opacity keyframe, direct-layer points + translucent vector (Bug 2 mirror), zoom-opacity × time-opacity composition, multi-property keyframes (Bug 1 mirror).                                                                                       |
| `animation.spec.ts`             | Production-demo cycle-continuity regression: `animation_pulse` and `animation_showcase`. 6-sample hash-uniqueness gate (≥4 distinct) + keyframe color histogram range check. Extracted from smoke.spec.ts.                                                                                                        |
| `reftest.spec.ts`               | Paired reference tests: renders two `.xgis` files that must produce identical output via different code paths; asserts `pixelDiffRatio < 0.5%` (no committed baseline images).                                                                                                                                    |
| `worldwrap-z0.spec.ts`          | World-copy regression guard: samples `tilesVisible` at ±540° longitude at z=0 and across a smooth pan, asserts count stays constant. Screenshots saved to `__worldwrap-z0__/`.                                                                                                                                    |
| `miter-check.spec.ts`           | Miter-join geometry correctness: captures apex crops and column pixel data for miter/bevel/round joins. Outputs to `__miter-check__/`.                                                                                                                                                                            |
| `_render-verify.spec.ts`        | Visual render gate for 11 production demos: non-background pixel ratio ≥ 1% + unique color count ≥ 3. Outputs PNGs to `__render-verify__/`.                                                                                                                                                                       |
| `_map-events.spec.ts`           | Map-level event delegation: `map.addEventListener('click')` fires with `event.target` = hit layer; `layer.preventDefault()` suppresses map delegation; `pointerdown`/`pointerup` fire on hit layer.                                                                                                               |
| `_pick-e2e.spec.ts`             | GPU picking pipeline e2e: 5×5 grid of `pickAt` calls on `multi_layer`, asserts ≥5 hits with non-zero `featureId` and ≥2 distinct IDs.                                                                                                                                                                             |
| `_layer-events-click.spec.ts`   | Layer-level click event delivery via `layer.addEventListener`.                                                                                                                                                                                                                                                    |
| `_layer-events-hover.spec.ts`   | Layer-level hover/mousemove event delivery.                                                                                                                                                                                                                                                                       |
| `_layer-events-remove.spec.ts`  | Event handler cleanup when a layer is removed.                                                                                                                                                                                                                                                                    |
| `_layer-style.spec.ts`          | Runtime style mutation via `layer.setStyle()` / opacity/fill/stroke setters.                                                                                                                                                                                                                                      |
| `_layer-pointer-events.spec.ts` | Pointer event filtering (`pointer-events: none` equivalent).                                                                                                                                                                                                                                                      |
| `_perf-scenarios.spec.ts`       | Frame-time benchmarks across hybrid/slow-CPU scenarios; outputs `__perf-scenarios__/report.json`.                                                                                                                                                                                                                 |
| `_profile-minimal.spec.ts`      | CPU profile of the minimal demo path; outputs to `__perf-scenarios__/`.                                                                                                                                                                                                                                           |
| `_profile-hybrid-stall.spec.ts` | CPU profile during tile-stall conditions under hybrid scenarios.                                                                                                                                                                                                                                                  |
| `_pmtiles-*.spec.ts`            | PMTiles-specific specs: render, overzoom, zoom14-blank, labels, protomaps-v4, layered, stress-leak, rapid-zoom-leak.                                                                                                                                                                                              |
| `_osm-style-*.spec.ts`          | OSM style specs: smoke, opacity, merge-proof, capture.                                                                                                                                                                                                                                                            |
| `_convert-bright*.spec.ts`      | OFM Bright style conversion: flat tile count, min demo, pitch-perf, full render, page redesign.                                                                                                                                                                                                                   |
| `__*__/` dirs                   | Screenshot/probe output directories from investigative specs (`__miter-check__`, `__worldwrap-z0__`, `__perf-scenarios__`, `__render-verify__`, `__pick-visual__`, `__interaction-audit__`, `__fixture-audit__`, `__line-regressions__`, `__convert-fixtures`, etc.). Not source files; excluded from spec globs. |

## Subdirectories

| Directory          | Purpose                                                                                                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helpers/`         | Reusable Playwright helpers: `visual.ts` (captureCanvas, colorHistogram, hashScreenshot, pixelDiffRatio, sampleNonBackgroundPixels), `validation.ts` (withValidationCapture, clearValidationErrors), `scenarios.ts` (loadScenario, CameraState), `natural-interaction.ts` (rAF-driven driver, FrameTimings) (see `helpers/AGENTS.md`). |
| `fixtures/`        | Static test data: camera-motion scenario JSON files (`seoul-zoomin`, `manhattan-pitch`, `global-globe-rotation`, `arctic-projection-flip`) (see `fixtures/AGENTS.md`).                                                                                                                                                                 |
| `spec-invariants/` | Parameterised invariant specs pinning camera-state and paint-property resolution contracts against live render traces: `camera-state.spec.ts`, `paint-resolution.spec.ts`, `label-antimeridian.spec.ts`, `label-text.spec.ts` (see `spec-invariants/AGENTS.md`).                                                                       |

## For AI Agents

### Working In This Directory

- All specs target `https://localhost:3000` (Vite dev server; `reuseExistingServer: true` in `playwright.config.ts` starts it automatically).
- `__xgisReady` must be truthy before any canvas capture or assertion — use `captureCanvas()` from `helpers/visual.ts`, never bare `page.waitForTimeout` as a readiness guard.
- `window.__xgisMap` exposes the live engine instance; access via `page.evaluate()` only, never cache across navigation.
- Stable specs (no `_` prefix) must stay green. If one breaks after your change, fix the production code — do not weaken the assertion.
- `_`-prefixed specs may use `test.skip()` / `test.fixme()` for known-broken states; leave a comment referencing the tracking note.
- Generated output directories (`__*__/`) are excluded by playwright config glob patterns; do not create source files inside them.
- Ship P0-7/P0-8 landed map lifecycle/camera events and a11y baseline; `_map-events.spec.ts` and `_pick-e2e.spec.ts` are the e2e coverage for that work.

### Testing Requirements

- `bun run test:e2e` from `playground/` runs all specs in `testDir: ./e2e`.
- Single spec: `bun run test:e2e e2e/smoke.spec.ts`.
- Visual regression baselines: `bun run test:e2e -- --update-snapshots` (requires a working GPU).
- Pixel-match specs set `workers: 1` in the spec itself; do not override.
- `HEADED=0` disables headed mode — only set if a GPU-enabled headless runner is available.
- `SMOKE_DEBUG=1` enables verbose console log dump per demo in smoke.spec.ts.

### Common Patterns

- Import visual helpers: `import { captureCanvas, expectPixelAt, colorHistogram, sampleNonBackgroundPixels, hashScreenshot, pixelDiffRatio } from './helpers/visual'`.
- Import validation helpers: `import { withValidationCapture, clearValidationErrors } from './helpers/validation'`.
- Navigate pattern: `await page.goto('/demo.html?id=<id>&e2e=1', { waitUntil: 'domcontentloaded' })` then await `__xgisReady` via `waitForFunction`.
- Animation sampling: `captureCanvas(page, { elapsedMsAtLeast: ms })` — drives `map._elapsedMs` forward before capture.
- Color histogram assertion: `fixtureColorAssert(page, id, buckets, ranges)` — asserts bucket ratio falls within `[min, max]`.
- Performance gate: assert `p95 < 50` and `max < 200` on `FrameTimings.frames` from `natural-interaction.ts`.
- Spec naming: stable suites use plain names (`smoke.spec.ts`); investigative specs use `_` prefix (`_debug-*.spec.ts`, `_perf-*.spec.ts`).

## Dependencies

### Internal

- `helpers/visual.ts` — `captureCanvas`, pixel utilities, `hashScreenshot`, `pixelDiffRatio`
- `helpers/validation.ts` — `withValidationCapture`, WebGPU error queue
- `helpers/scenarios.ts` — `loadScenario`, `CameraState`, `Scenario`
- `helpers/natural-interaction.ts` — rAF-driven interaction driver, `FrameTimings`
- `@xgis/runtime` (via playground Vite dev server)

### External

- `@playwright/test` ^1.59.1
- `pixelmatch` ^7.2.0, `pngjs` ^7.0.0 (pixel-diff specs only)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
