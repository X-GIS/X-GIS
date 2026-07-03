<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# playground/e2e/spec-invariants

## Purpose

Parameterised invariant specs that run against live `captureNextFrameTrace()` output from the engine to pin correctness contracts the unit-test suite cannot verify in isolation (they require a real WebGPU render pass + full tile pipeline). These specs assert that values flowing through the compiler → runtime → GPU pipeline emerge with exactly the right values at the frame-trace level, catching regressions in camera matrix composition, zoom-interpolated paint property resolution, label text/font/color resolution, and antimeridian label placement. They complement pixel-match tests by catching regressions at the structured-data layer rather than at the composited canvas output.

## Key Files

| File                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `camera-state.spec.ts`       | Pins zoom, bearing, pitch, projection name, and viewport/DPR through the render loop. Navigates `compare.html?style=openfreemap-bright#<hash>`, waits for `__xgisReady` + 6 s settle, calls `captureNextFrameTrace()`, and asserts `cameraZoom` (±0.01), `cameraBearing` (±0.1°), `cameraPitch` (±0.1°), `projection === 'mercator'`, and `viewportPx`/`dpr > 0`. Tile-LOD `selectedCz` test is `.skip`-ped pending VTR hook wiring.                                                          |
| `paint-resolution.spec.ts`   | Pins Mapbox-spec `interpolate ["linear"]` stop resolution for `line-opacity` and `line-width` on demotiles `countries-boundary` across zoom levels 2–8. Verifies clamp-to-endpoint at z=2 (opacity=0.5), linear interp at z=4 (opacity≈0.6667), saturation at z=6 (opacity=1.0), and width interp at z=2 (1.2 px) and z=8 (3.0 px). Note: constant `line-color` is NOT in the trace resolved slot (it lives statically on `paintShapes.stroke`). Uses 8 s settle; style `maplibre-demotiles`. |
| `label-text.spec.ts`         | Asserts on the resolved label string submitted to the GPU. Covers: demotiles ABBREV vs NAME zoom-step resolution for Korea at z=3/z=5; geolines curve placement + color (#1077B0); countries-label font-weight 600 (Semibold); OFM Bright `water_name` navy color (#495e91); OFM Bright `label_country_2` font-weight 700 (Noto Sans Bold). Assertions that fire only when the label is in view are explicitly documented as no-ops otherwise.                                                |
| `label-antimeridian.spec.ts` | Regression gate for commit 7df23d0 — antimeridian wrap-copy clustering. Loads OFM Bright via `convertMapboxStyle` + base64 encode into `demo.html?id=__import`, positions camera at zoom=0.5/lon=175.54 (near antimeridian), captures trace after 15 s settle + two rAF nudges, and asserts that no 5-px x-bucket holds more than 3 distinct on-screen label strings. Imports `@xgis/compiler` directly and reads `openfreemap-bright.json` fixture via `node:fs`.                            |

## For AI Agents

### Working In This Directory

- All specs use `window.__xgisMap.captureNextFrameTrace()`. If the method is absent the spec throws immediately with a descriptive error — check runtime exports before debugging test failures.
- `camera-state.spec.ts` and `paint-resolution.spec.ts` navigate `compare.html`; `label-text.spec.ts` also navigates `compare.html`; `label-antimeridian.spec.ts` navigates `demo.html?id=__import` with a base64-encoded style payload.
- Settle waits are 6 s (camera), 8 s (paint/label-text), and 15 s (antimeridian). Do not reduce them — tile-load races cause flaky assertions.
- `label-antimeridian.spec.ts` reads `compiler/src/__tests__/fixtures/openfreemap-bright.json` via a relative path (`../../..` from spec location). If the fixture moves, this path breaks.
- The `FrameTrace` interface is defined locally in each spec (not imported from runtime) to decouple specs from internal type churn — keep it that way.
- Do not use `toMatchSnapshot()`. All invariants must be explicit numeric assertions with named tolerances.
- Constant paint values (e.g. `line-color: rgba(255,255,255,1)`) are NOT recorded in the trace's resolved slot — they live statically on `paintShapes.stroke`. Only dynamic (zoom-interpolated) values appear in the trace.
- The `tileLOD.selectedCz` test in `camera-state.spec.ts` is `test.skip`-ped pending wiring in `vector-tile-renderer.ts`. Do not remove it — it documents the expected z+0.7 floor rule.

### Testing Requirements

- Run via `bun run test:e2e` from `playground/`. These specs require the Vite dev server; they are slow (10–120 s per test). Do not add tests here without strong justification.
- Camera hash format: `#z/lat/lon[/bearing[/pitch]]` (same as `demo.html`/`compare.html`).
- `label-antimeridian.spec.ts` also imports `@xgis/compiler` — the compiler package must be built before this spec runs.

### Common Patterns

- `captureTrace(page, hash, style?)` helper: `page.goto` → `waitForFunction(__xgisReady, timeout:30s)` → `waitForTimeout(N)` → `page.evaluate(map.captureNextFrameTrace())`.
- Floating-point tolerances: ±0.01 for zoom (2 decimals), ±0.1° for bearing/pitch (1 decimal), ±0.001–0.01 for paint values (2–3 decimals).
- Layer-name normalisation: X-GIS may lowercase and underscore Mapbox layer IDs (`countries-boundary` → `countries_boundary`); use a regex like `/countries[-_]boundary/` when searching the trace.
- Antimeridian spec uses a 5-px histogram bucket and `worstSize ≤ 3` as the cluster ceiling; log output from the worst bucket is printed for diagnosis on failure.

## Dependencies

### Internal

- `window.__xgisMap.captureNextFrameTrace` (runtime debug API on `XGISMap`)
- `window.__xgisReady` (set by `web/entry.ts` after first render)
- `@xgis/compiler` (`convertMapboxStyle` — antimeridian spec only)
- `compiler/src/__tests__/fixtures/openfreemap-bright.json` (antimeridian spec fixture)
- OFM Bright + demotiles styles (network, served via Vite dev server)

### External

- `@playwright/test`
- `node:fs`, `node:url`, `node:path` (antimeridian spec only, Node-side fixture loading)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
