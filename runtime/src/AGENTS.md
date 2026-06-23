<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-23 -->

# src

## Purpose
Root of the `@xgis/runtime` source tree. The four top-level source files are the public entry barrel (`index.ts`), the runtime capability flag table (`capabilities.ts`), a Vite worker-query ambient shim (`vite-shims.ts`), and an ambient type declaration for `earcut` (`earcut.d.ts`). All substantive implementation lives in seven subdirectories: `engine/` (camera, projections, WebGPU device/context, all render passes, text/SDF/PBF glyph pipeline, sprite atlas, GPU staging buffers), `data/` (tile catalog/router, per-format source backends, GeoJSON tiling worker pool, filter/extrude eval, polar-cap synthesis), `loader/` (GeoJSON parser, vector-tile-loader for PMTiles/TileJSON, SSE tile selector, polar-cap detector), `core/` (GPU-free geometry/scheduling primitives), `web/` (the `<xgis-map>` custom element), `debug/` (CPU-only tile-pipeline predictor and simulator), and `diagnostics/` (per-frame render-trace capture).

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Public barrel. Re-exports `XGISMap`, `StatsPanel`, `StatsTracker`, `Camera`, `MapRenderer`, `loadGeoJSON`, `lonLatToMercator`, polar-cap helpers (`injectPolarCaps`, `synthesizePolarCaps`, `projectionNeedsPolarCaps`, et al.), `RUNTIME_CAPABILITIES`/`runtimeCapability`/`runtimeGaps`, `VectorTileLoader`, `VectorTileSource`, `PMTilesArchiveSource`, `TileJSONSource`, `XGISMapElement`/`registerXGISElement`, projection factories (`mercator`, `equirectangular`, `naturalEarth`, `orthographic`, `getProjection`), `ComputeDispatcher`, and color-ramp helpers. Only import surface for `playground/` and `site/`. |
| `capabilities.ts` | `RUNTIME_CAPABILITIES` — per `(layerType, property, variant)` flags of what the renderer honours vs silently drops/degrades. Variants: `constant`, `zoom-interp`, `data-driven`. `runtimeGaps()` returns the unsupported subset. The `__tests__/spec-coverage-runtime-drift.test.ts` gate fails on stale or missing entries. |
| `capabilities.test.ts` | Top-level unit test for the capability table itself (coverage of `runtimeCapability` lookup and `runtimeGaps` output shape). Lives at root level, not under `__tests__/`. |
| `vite-shims.ts` | Ambient `declare module '*?worker'` shim for Vite's worker-query import suffix. Kept as `.ts` (not `.d.ts`) because `.gitignore` excludes `runtime/src/**/*.d.ts` as build artifacts. |
| `earcut.d.ts` | Hand-authored ambient type declaration for the `earcut` polygon-tessellation package (no bundled types in the package itself). |
| `test-setup-projections.ts` | Vitest global setup file that configures the shader-dsl projection graph via `configureProjections(PROJECTIONS)` before any test suite runs; ensures projection emit and CPU-projection access work across the entire test suite. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `core/` | GPU-free geometry and scheduling primitives: line-segment build, polygon mesh construction, boundary-cap suppression, priority queue (see `core/AGENTS.md`). |
| `data/` | Tile catalog/router, per-format source backends, GeoJSON tiling worker pool, filter/extrude eval, polar-cap synthesis (see `data/AGENTS.md`). |
| `debug/` | CPU-only tile-pipeline predictor and simulator for deterministic coverage analysis without a GPU (see `debug/AGENTS.md`). |
| `diagnostics/` | `RenderTrace` — per-frame capture of render intent (layer draws, tile decisions) for offline analysis (see `diagnostics/AGENTS.md`). |
| `engine/` | Camera, 8-surface projections, WebGPU device/context, all render passes, text/SDF/PBF glyph pipeline, sprite atlas, GPU staging buffers (see `engine/AGENTS.md`). |
| `loader/` | GeoJSON loader, vector-tile-loader (PMTiles/TileJSON), SSE tile selector, SSRF-guarded fetch, polar-cap detector (see `loader/AGENTS.md`). |
| `web/` | `XGISMapElement` / `registerXGISElement` — the `<xgis-map>` custom element wrapper (see `web/AGENTS.md`). |

`__tests__/` holds cross-cutting integration tests (cross-validation fixture, spec-coverage drift, WebGPU stub smoke). `__test-support__/` holds `webgpu-stub.ts` — the shared WebGPU mock used across the entire test suite.

## For AI Agents

### Working In This Directory
- Any new paint/layout property runtime support must add a matching row to the per-layer-type descriptor under `capabilities/` (e.g. `capabilities/circle.ts`, `capabilities/background.ts`) — NOT the assembler `capabilities.ts`, which just spreads the descriptors. Splitting the table by layer type keeps independent axes (e.g. a circle change vs a background change) in different files, so they never conflict and can be implemented in parallel. The `__tests__/spec-coverage-runtime-drift.test.ts` gate fails on missing or stale entries.
- New public symbols must be added to `index.ts`; `playground/` and `site/` import exclusively from `@xgis/runtime`, never via deep paths.
- `vite-shims.ts` must stay as a `.ts` file (not `.d.ts`) — `.gitignore` excludes `*.d.ts` in this tree as build artifacts.
- `earcut.d.ts` is hand-authored; do not delete it. The actual `earcut` package has no bundled types.
- `capabilities.test.ts` lives at the top level of `src/`, not under `__tests__/`. Keep it there.

### Testing Requirements
- `__tests__/spec-coverage-runtime-drift.test.ts` — gates `capabilities.ts` against the compiler's spec coverage list; must pass after any capability change.
- `__tests__/gap-matrix-freshness.test.ts` — detects stale entries in the gap matrix.
- `__tests__/cross-validation.test.ts` — pins CPU projection/tile math to `cross-validation.fixture.json` (generated by the Python pyproj/mercantile/shapely harness under `scripts/cross-validation/`).
- `__tests__/epsg-reprojection-crossval.test.ts` — cross-validates EPSG reprojection paths.
- `__tests__/webgpu-stub.test.ts` — smoke-tests the shared WebGPU stub used throughout the suite.
- `capabilities.test.ts` — unit tests for the capability lookup API.
- Run `bun run build` before pushing — vitest does not typecheck, the build does.

### Common Patterns
- Capability table variant values are exactly `'constant' | 'zoom-interp' | 'data-driven'`. Set `supported: false` only when the runtime drops/degrades input, and always include a `note`.
- All cross-package imports use `@xgis/compiler` type aliases, never relative paths into `../compiler/`.

## Dependencies

### Internal
- Consumes all seven subdirectory subsystems; re-exports their public APIs through `index.ts`.
- `@xgis/compiler` — type imports for IR/style types used throughout engine and data layers.

### External
- `earcut` — polygon tessellation.
- `@webgpu/types` — WebGPU TypeScript type definitions.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
