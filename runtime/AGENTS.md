<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# runtime (@xgis/runtime)

## Purpose
`@xgis/runtime` is the rendering half of X-GIS: it consumes the compiler's output (SceneCommands, ShaderVariant, CompiledTile) and paints maps on the GPU. It owns the WebGPU renderers (vector tiles, raster tiles, true-3D globe, points, lines, text, icons), a Canvas-2D-free WebGPU-first pipeline, camera math, pointer interaction, and the full MVT/PBF vector-tile pipeline (HTTP/PMTiles or in-memory GeoJSON → decode → decompose → compile → earcut in Mercator space → line-segment build → DSFUN GPU buffers). Seven projections are baked into the shaders, each with paired CPU (`projection.ts`) and GPU (WGSL) implementations that must agree exactly.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | `@xgis/runtime` workspace pkg. Deps: `@xgis/compiler`, `pmtiles`, `@chenglou/pretext`. Dev: `geojson-vt`, `vt-pbf`. |
| `src/index.ts` | Public barrel — re-exports `XGISMap`, `Camera`, `MapRenderer`, `loadGeoJSON`, projection factories, polar-cap synth, `VectorTileLoader`, `RUNTIME_CAPABILITIES`, web component. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | All runtime source (see `src/AGENTS.md`). |
| `scripts/` | One-off PMTiles inspection / verification scripts (see `scripts/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- WebGPU-first. Renderers assume a `GPUDevice`; pure logic (tile math, packing, collision, layout) is deliberately split into GPU-free modules so it is unit-testable without a device (see the `__test-support__/webgpu-stub`).
- **CPU↔GPU projection parity is a hard contract.** Any edit to `engine/projection/projection.ts` (CPU) must mirror `engine/shaders/projection.ts` (WGSL source of truth) and the TS mirror `engine/projection/projection-wgsl-mirror.ts`. Divergences here are a documented recurring bug class.
- **Tile selection + budget is bug-prone.** `data/tile-select.ts`, `loader/tiles-sse.ts`, `data/tile-catalog.ts`, and the VTR per-tile loop interact through implicit budgets (upload/frame, GPU-cache LRU, SSE). Gate any change on concrete e2e tile/perf numbers vs a mercator control.
- earcut runs in Mercator-projected coordinates so triangle edges match the GPU. Never re-tessellate per projection — projections switch via a GPU uniform.

### Testing Requirements
- Colocated `*.test.ts` (vitest) throughout. `bun run test` from repo root; does NOT typecheck — run `bun run build` before commits that touch destructuring/locals.
- Perf / tile-selection / projection changes additionally gate on the Playwright suites in `playground/` (`test:pixel`, `test:perf`, `test:projection`, `test:e2e`).

### Common Patterns
- `// ═══ Title ═══` banner comments head most modules; many carry Korean section headers.
- Pure logic extracted out of GPU classes into sibling modules (e.g. `line-segment-build.ts` out of `line-renderer.ts`, `polygon-mesh.ts`, `tile-decision.ts`, `bucket-scheduler.ts`) for testability — the GPU class re-exports the public surface.
- DSFUN (double-single floating-point) split-precision packing: positions stored as high+low f32 pairs so the shader recovers camera-relative meters at f64-equivalent precision.

## Dependencies

### Internal
- `@xgis/compiler` — SceneCommands, ShaderVariant, CompiledTile, `decodeMvtTile`/`decomposeFeatures`/`compileSingleTile`, geojson-vt port, palette, expression `evaluate`.

### External
- `pmtiles` — PMTiles archive reader.
- `@chenglou/pretext` — text layout helper.
- `earcut` — polygon triangulation.
- `geojson-vt`, `vt-pbf` (dev) — in-memory GeoJSON tiling + MVT encoding for the virtual-PMTiles path.
- `@webgpu/types` — WebGPU type definitions.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
