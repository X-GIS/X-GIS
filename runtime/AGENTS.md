<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# runtime (@xgis/runtime)

## Purpose
`@xgis/runtime` is the WebGPU rendering half of X-GIS. It consumes `@xgis/compiler` output (SceneCommands, ShaderVariant, CompiledTile) and paints maps on the GPU. It owns: the WebGPU renderers (vector tiles, raster, lines, points, text/SDF, icons, globe); camera math and pointer interaction; the full MVT/PBF vector-tile pipeline (HTTP, PMTiles, in-memory GeoJSON → decode → decompose → compile → earcut → DSFUN GPU buffers); eight projection surfaces (projType 0–7, Mercator through true-3D globe/ECEF) each with a paired CPU implementation generated from the same shader DSL IR; SDF glyph rasterisation and PBF font loading; sprite atlas; and a `<xgis-map>` custom element. **WebGPU-only** — `initGPU` throws `WebGPUUnavailableError` when the adapter is absent; there is no Canvas 2D render fallback.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | `@xgis/runtime` workspace package (`private: true`, ESM). Deps: `@xgis/compiler`, `@xgis/shared`, `pmtiles`, `@chenglou/pretext`, `proj4`. Dev: `geojson-vt`, `vt-pbf`. |
| `tsconfig.json` | TypeScript project-reference config. Resolves `@xgis/compiler` and `@xgis/shared` via `../compiler/dist/index.d.ts` and `../shared/dist/index.d.ts`; also resolves `@xgis/compiler/tiler/geodesic`; emits to `./dist`; adds `@webgpu/types`. |
| `src/index.ts` | Public barrel. Re-exports: `XGISMap`, `Camera`, `MapRenderer`, `StatsPanel`/`StatsTracker`, `loadGeoJSON`/`lonLatToMercator`, projection factories (`mercator`, `equirectangular`, `naturalEarth`, `orthographic`, `getProjection`), polar-cap helpers, `VectorTileLoader`/`VectorTileSource`/`PMTilesArchiveSource`/`TileJSONSource`, `XGISMapElement`/`registerXGISElement`, `ComputeDispatcher`, `createColorRampTexture`/`createRampSampler`/`availableRamps`, `RUNTIME_CAPABILITIES`/`runtimeCapability`/`runtimeGaps`. |
| `src/capabilities.ts` | `RUNTIME_CAPABILITIES` matrix — per `(layerType, property, variant)` flags what the renderer actually honours, paired with the compiler's spec-coverage table to surface silent drops. |
| `src/vite-shims.ts` | Ambient `declare module '*?worker'` shim for Vite's worker-bundle query suffix. Kept as `.ts` (not `.d.ts`) so it is tracked by git. |
| `src/earcut.d.ts` | Re-export type declaration for the earcut triangulation function bundled via the compiler package. |
| `src/engine/event-dispatcher.ts` | Pointer-event dispatcher: bridges controller pointer events to per-layer listener registries via `pickAt`. Owns cross-frame hover state `(layerId, featureId)` for `mouseenter`/`mouseleave` semantics. pickAt is rAF-coalesced; fires ~1 frame after click due to WebGPU `copyTextureToBuffer + mapAsync` latency. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | All runtime source — engine, data, loader, core, web, debug, diagnostics subsystems (see `src/AGENTS.md`). |
| `scripts/` | One-off PMTiles inspection / verification scripts (see `scripts/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- **WebGPU-first.** Renderers assume a `GPUDevice`. Pure logic (tile math, packing, collision, layout) is deliberately split into GPU-free sibling modules so vitest can test them without a device (see `src/__test-support__/webgpu-stub`).
- **CPU↔GPU projection parity is a hard contract.** The CPU mirror of the WGSL projections is code-generated from the shader DSL IR (`engine/shader-dsl/`), not hand-maintained. Any edit to a projection function must go through the DSL; hand-editing only one side is a documented recurring bug class. See ADR `0003-shader-dsl-single-emit`.
- **earcut runs in Mercator-projected coordinates** so triangle edges match the GPU. Projections switch via a GPU uniform — never re-tessellate per projection.
- **DSFUN split-precision packing** (high+low f32 pairs) recovers camera-relative metres at ~f64 precision; tiles pack ECEF metres. See ADR `0001-ecef-tile-pipeline`.
- **Tile selection + GPU budget is bug-prone.** `data/tile-select.ts`, `loader/tiles-sse.ts`, `data/tile-catalog.ts`, and the VTR per-tile loop interact through implicit budgets (upload/frame, GPU-cache LRU byte-aware eviction, SSE). Gate any change on concrete e2e tile/perf numbers vs a Mercator control.
- `bun run build` typechecks the workspace; `bun run test` (vitest) does NOT typecheck. Always build before committing type-affecting changes.
- God-object caveat: `engine/render/vector-tile-renderer.ts` (~5600 LOC), `engine/map.ts` (~2800 LOC), and `engine/text/text-stage.ts` own state that should be distributed — documented #1 architectural debt in `docs/architecture/MODULES.md §4`. Do not assume these files are cleanly layered.

### Testing Requirements
- Colocated `*.test.ts` (vitest) throughout `src/`. Run via `bun run test` from the repo root.
- `src/__test-support__/` provides WebGPU stubs; `src/__tests__/` holds integration-level tests. Neither directory's internals should be enumerated in file listings.
- Perf, tile-selection, and projection changes additionally gate on Playwright suites in `playground/`: `test:pixel`, `test:perf`, `test:projection`, `test:e2e`.
- CI runs no-GPU pure-compute/WGSL-compile gates under SwiftShader only. Render-correctness (pixel-match) runs locally on a real GPU. See ADR `0004-verification-gate-strategy` and `docs/verification/STRATEGY.md`.

### Common Patterns
- `// ═══ Title ═══` banner comments head most modules; many carry Korean section headers in larger files.
- Pure logic is extracted from GPU classes into GPU-free sibling modules (e.g. `line-segment-build.ts`, `polygon-mesh.ts`, `tile-decision.ts`, `bucket-scheduler.ts`) for testability; the GPU class re-exports the public surface.
- Worker pools (GeoJSON tiling, MVT decode) live under `src/data/workers/` and communicate via structured-clone messages.

## Dependencies

### Internal
- `@xgis/compiler` — SceneCommands, ShaderVariant, CompiledTile, `decodeMvtTile`/`decomposeFeatures`/`compileSingleTile`, geojson-vt port, palette, expression `evaluate`, geodesic utilities.
- `@xgis/shared` — shared types and utilities.

### External
- `pmtiles` — PMTiles archive reader.
- `@chenglou/pretext` — text layout helper.
- `proj4` — EPSG input-data reprojection (**user-approved zero-dep-policy exception**, input side only; the eight display projections remain hand-written via the shader DSL).
- `earcut` — polygon triangulation (bundled via compiler, exposed via `src/earcut.d.ts`).
- `geojson-vt`, `vt-pbf` (dev) — in-memory GeoJSON tiling + MVT encoding for the virtual-PMTiles path.
- `@webgpu/types` — WebGPU type definitions (TypeScript only).

<!-- MANUAL: notes below this line are preserved on regeneration -->

### Zero-dep policy exception: `proj4` (user-approved, 2026-05-22)
The repo's standing rule is to avoid adding npm dependencies and prefer
hand-written code. `proj4` is an **explicit, user-approved exception** for the
EPSG input-reprojection feature (plan: `.omc/plans/epsg-input-reprojection.md`,
Decision Driver #1). Supporting arbitrary input EPSG codes requires a general
projection library; hand-coding the Transverse-Mercator + datum math to <1mm is
the documented "Option C — rejected (<1mm hand-coding risk)". `proj4` is only
used on the **input side** (input data → WGS84 lon/lat); the eight **display**
projections remain hand-written in `engine/projection/` and are untouched.

The EPSG def registry lives at `src/data/sources/epsg-defs.ts` (registers
codes proj4 does not bundle — currently EPSG:5179 / 5186 — and throws a clear
error for unregistered/invalid codes). Its AC0 precision spike pinned the
cross-validation tolerance at **1e-3 m (1mm), measured at EPSG:3857 meters**
(actual proj4js↔pyproj divergence ≈ 3.7e-9 m).
