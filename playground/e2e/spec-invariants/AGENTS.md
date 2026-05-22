<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/e2e/spec-invariants

## Purpose
Parameterised invariant specs that run against live `captureNextFrameTrace()` output from the engine to pin correctness contracts that the unit-test suite cannot verify in isolation (they require a real WebGPU render pass + tile pipeline). These specs assert that values which flow through the full compiler → runtime → GPU pipeline emerge with exactly the right values at the frame trace level, catching regressions in camera matrix composition, paint property interpolation, label resolution, and text/antimeridian behaviour.

## Key Files
| File | Description |
|------|-------------|
| `camera-state.spec.ts` | Pins bearing, pitch, projection, viewport size, and DPR through the render loop. Navigates `compare.html?style=openfreemap-bright#<hash>`, waits for `__xgisReady` + 6s settle, calls `map.captureNextFrameTrace()`, and asserts `cameraZoom`, `cameraCenter`, `cameraBearing`, `cameraPitch`, `projection`, `viewportPx`, `dpr`, and `tileLOD.selectedCz` match expected values within tolerance. |
| `paint-resolution.spec.ts` | Pins Mapbox-spec `interpolate ["linear"]` stop resolution for `line-opacity`, `line-color`, and `line-width` on the `countries-boundary` layer across zoom levels 1–22. Verifies clamp-to-endpoint extrapolation outside stop range. |
| `label-text.spec.ts` | Invariant for label text content and position stability: asserts specific label strings are present in the frame trace at a stable location across frames. |
| `label-antimeridian.spec.ts` | Asserts that labels crossing the antimeridian are correctly placed on both sides of the world-copy boundary. |

## Subdirectories
*(none)*

## For AI Agents

### Working In This Directory
- These specs use `map.captureNextFrameTrace()` — a debug API on `XGISMap` that returns a structured snapshot of the next rendered frame. If this method is absent, specs throw immediately with a descriptive error.
- `captureNextFrameTrace()` is gated on `__xgisReady` plus a multi-second settle wait (typically 6s) to let tiles load before sampling the trace. Do not reduce the settle time — tile-load races cause flaky assertions.
- Invariant specs are stricter than pixel-match specs: they assert exact numeric values (with tolerance) on structured data, not pixel outputs. A failure here points directly at a specific field in the pipeline.
- When adding a new invariant: (1) identify the field in `FrameTrace` that should be pinned, (2) compute the expected value analytically from the spec, (3) add a test with a descriptive name that names both the input (zoom level / camera hash) and the expected output.
- Do not use `toMatchSnapshot()` here — invariants must be explicit numeric assertions with named tolerances.

### Testing Requirements
- Run as part of the full `bun run test:e2e` suite from `playground/`.
- These specs require the Vite dev server (OFM Bright style fetches tiles from the network); they are slow (~10-15s per test due to settle wait). Do not add more than necessary.
- Camera hash format: `#z/lat/lon/bearing/pitch` (same as `demo.html`).

### Common Patterns
- `captureTrace(page, hash)` local helper pattern: navigate → `waitForFunction(__xgisReady)` → `waitForTimeout(6000)` → `page.evaluate(map.captureNextFrameTrace())`.
- Tolerance for floating-point camera values: ±0.01 for zoom, ±0.1° for bearing/pitch.
- The `FrameTrace` interface is defined locally in each spec (not imported from runtime) to keep the spec self-contained and decouple it from internal type changes.

## Dependencies

### Internal
- `window.__xgisMap.captureNextFrameTrace` (runtime debug API)
- `window.__xgisReady`
- OFM Bright style tiles (network, openfreemap.org)

### External
- `@playwright/test`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
