<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# src

## Purpose
Root of the `@xgis/runtime` source tree. Top level holds the public entry barrel and the runtime capability matrix; everything substantial lives in the four subsystem dirs: `engine/` (camera, projections, GPU context, renderers, text/icon stages), `data/` (tile catalog/router, per-format backends, decode workers, filter eval), `loader/` (GeoJSON parsing, vector-tile-loader, SSE tile selection, polar-cap detection), and `web/` (the `<xgis-map>` custom element).

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Public barrel. Re-exports `XGISMap`, `Camera`, `MapRenderer`, `loadGeoJSON`, `lonLatToMercator`, projection factories, `ComputeDispatcher`, polar-cap synth/detect, `VectorTileLoader` + PMTiles helpers, color-ramp helpers, `XGISMapElement`, `RUNTIME_CAPABILITIES`. |
| `capabilities.ts` | `RUNTIME_CAPABILITIES` table — per `(layerType, property, variant)` flag of what the renderer actually honours vs silently drops/degrades. Pairs with `compiler/.../spec-coverage.ts`; the drift test gates missing entries. |
| `earcut.d.ts` | Ambient type decl for the `earcut` package. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `core/` | GPU-free geometry/scheduling primitives (line-segment build, polygon mesh, priority queue) (see `core/AGENTS.md`). |
| `data/` | Tile catalog/router, per-format backends, decode worker pools, filter/extrude eval, polar-cap synth (see `data/AGENTS.md`). |
| `engine/` | Camera, projections, WebGPU context, all renderers, text/icon/sprite stages (see `engine/AGENTS.md`). |
| `loader/` | GeoJSON loader, vector-tile-loader, SSE tile selector, polar-cap detector (see `loader/AGENTS.md`). |
| `debug/` | CPU-only tile-pipeline predictor + simulator (see `debug/AGENTS.md`). |
| `diagnostics/` | FrameTrace capture of per-frame render intent (see `diagnostics/AGENTS.md`). |
| `web/` | `<xgis-map>` custom element (see `web/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- When you add or change a paint/layout property's runtime support, update the matching row in `capabilities.ts` — the `spec-coverage-runtime-drift.test.ts` gate fails on a stale or missing entry.
- New public symbols must be exported through `index.ts`; `playground`/`site` import only from `@xgis/runtime`.

### Testing Requirements
- `__tests__/spec-coverage-runtime-drift.test.ts` and `gap-matrix-freshness.test.ts` enforce `capabilities.ts` consistency.
- `__tests__/cross-validation.test.ts` pins CPU projection/tile math to the `cross-validation.fixture.json` (pyproj/mercantile/shapely reference).

### Common Patterns
- The capability table uses three variants per property: `constant`, `zoom-interp`, `data-driven`. Set `supported: false` ONLY when the runtime drops/degrades the input, with a `note`.

## Dependencies

### Internal
- All subsystem dirs below; `@xgis/compiler` types throughout.

### External
- `earcut`, `@webgpu/types`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
