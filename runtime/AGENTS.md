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
- **CPU↔GPU projection parity is a hard contract.** Any edit to `engine/projection/projection.ts` (CPU) must mirror `engine/shaders/projection.ts` (WGSL source of truth) and the GENERATED cpu-f64 lowering `engine/shader-dsl/cpu-projections.ts` (from the IR in `engine/shader-dsl/projections.ts` — formerly the hand-maintained `projection-wgsl-mirror.ts`, now deleted). Divergences here are a documented recurring bug class.
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
- `proj4` — EPSG input-data reprojection (see zero-dep exception below).
- `geojson-vt`, `vt-pbf` (dev) — in-memory GeoJSON tiling + MVT encoding for the virtual-PMTiles path.
- `@webgpu/types` — WebGPU type definitions.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

### Zero-dep policy exception: `proj4` (user-approved, 2026-05-22)
The repo's standing rule is to avoid adding npm dependencies and prefer
hand-written code. `proj4` is an **explicit, user-approved exception** for the
EPSG input-reprojection feature (plan: `.omc/plans/epsg-input-reprojection.md`,
Decision Driver #1). Supporting arbitrary input EPSG codes requires a general
projection library; hand-coding the Transverse-Mercator + datum math to <1mm is
the documented "Option C — rejected (<1mm hand-coding risk)". `proj4` is only
used on the **input side** (input data → WGS84 lon/lat); the seven **display**
projections remain hand-written in `engine/projection/` and are untouched.

The EPSG def registry lives at `src/data/sources/epsg-defs.ts` (registers
codes proj4 does not bundle — currently EPSG:5179 / 5186 — and throws a clear
error for unregistered/invalid codes). Its AC0 precision spike pinned the
cross-validation tolerance at **1e-3 m (1mm), measured at EPSG:3857 meters**
(actual proj4js↔pyproj divergence ≈ 3.7e-9 m).
