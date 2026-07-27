<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# runtime (@xgis/runtime)

## Purpose

`@xgis/runtime` is the **published distribution** of X-GIS — the only non-private package in the monorepo. It owns almost no implementation (~1.8k LOC of source): a public barrel that re-exports `@xgis/map` (XGISMap, Camera, renderers, color ramps), `@xgis/data` (loaders, sources, polar caps), `@xgis/geo` (projection factories) and `@xgis/rhi-webgpu` (ComputeDispatcher); the `RUNTIME_CAPABILITIES` table; and the `<xgis-map>` custom element. The Vite lib build bundles every internal `@xgis/*` package into one `dist/`. **WebGPU-only** — `initGPU` throws `WebGPUUnavailableError` when the adapter is absent; there is no Canvas 2D render fallback.

> **`src/**` is mostly TESTS.** 259 of the 278 `.ts` files here are `*.test.ts` that exercise `@xgis/map` / `@xgis/data` from this package — residue of the package extraction (`src/engine/**` in particular tests `@xgis/map`, NOT `@xgis/engine`). They are being relocated to the packages they test; do not add new ones here.

## Key Files

| File                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`         | `@xgis/runtime` workspace package (ESM, `type: module`). Runtime deps: `@mapbox/vector-tile`, `@webgpu/types`, `earcut`, `pbf`, `pmtiles`, `proj4` — the third-party externals only. Every `@xgis/*` workspace package is a devDependency: they are `private: true` and get bundled into `dist/`, so a published `dependencies` entry would be an unresolvable `workspace:*`.                                                                                                                                                                                          |
| `tsconfig.json`        | TypeScript project-reference config. Resolves `@xgis/compiler`, `@xgis/shared`, and `@xgis/shader-dsl` via their `../*/dist/index.d.ts`; also resolves `@xgis/compiler/tiler/geodesic` and `@xgis/shader-dsl/*`; emits to `./dist`; adds `@webgpu/types`.                                                                                                                                                                                                                                                                                                              |
| `vite.config.ts`       | Library build config for `@xgis/runtime`. Bundles every internal `@xgis/*` source (map, data, geo, engine, rhi, rhi-webgpu, compiler, shader-dsl, shared) reachable from the barrel; externalises third-party deps (`earcut`, `proj4`, `pmtiles`, `pbf`, `@mapbox/vector-tile` — the `EXTERNAL` array); configures worker chunks (`?worker` graph) and asset paths (`base: './'`) for ESM consumers and re-bundlers.                                                                                                                                                   |
| `src/index.ts`         | Public barrel. Re-exports: `XGISMap`, `Camera`, `MapRendererContent`, `FrameRenderer`, `Marker`/`Popup`, `StatsPanel`/`StatsTracker`, `loadGeoJSON`/`lonLatToMercator`, projection factories (`mercator`, `equirectangular`, `naturalEarth`, `orthographic`, `getProjection`), polar-cap helpers, `VectorTileLoader`/`VectorTileSource`/`PMTilesArchiveSource`/`TileJSONSource`, `XGISMapElement`/`registerXGISElement`, `ComputeDispatcher`, `createColorRampTexture`/`createRampSampler`/`availableRamps`, `RUNTIME_CAPABILITIES`/`runtimeCapability`/`runtimeGaps`. |
| `src/capabilities.ts`  | `RUNTIME_CAPABILITIES` matrix — per `(layerType, property, variant)` flags what the renderer actually honours, paired with the compiler's spec-coverage table to surface silent drops.                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/vite-shims.ts`    | Ambient `declare module '*?worker'` shim for Vite's worker-bundle query suffix. Kept as `.ts` (not `.d.ts`) so it is tracked by git.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/earcut.d.ts`      | Re-export type declaration for the earcut triangulation function bundled via the compiler package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/web/component.ts` | `XGISMapElement` / `registerXGISElement` — the `<xgis-map>` custom element wrapping `XGISMap`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Subdirectories

| Directory  | Purpose                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/`     | The barrel, the capability table, the web component — plus the not-yet-relocated test corpus (see `src/AGENTS.md`). |
| `scripts/` | One-off PMTiles inspection / verification scripts (see `scripts/AGENTS.md`).                                        |

## For AI Agents

### Working In This Directory

- **Implementation does not belong here.** A change to a renderer, the camera, the tile pipeline or a projection goes to `@xgis/map` / `@xgis/data` / `@xgis/geo`. The only source you should edit here is the barrel, `capabilities/`, and `web/component.ts`.
- **WebGPU-first.** Renderers assume a `GPUDevice`. Pure logic (tile math, packing, collision, layout) is deliberately split into GPU-free sibling modules so vitest can test them without a device (see `src/__test-support__/webgpu-stub`).
- **CPU↔GPU projection parity is a hard contract.** The CPU mirror of the WGSL projections is code-generated from the shader DSL IR (`engine/shader-dsl/`), not hand-maintained. Any edit to a projection function must go through the DSL; hand-editing only one side is a documented recurring bug class. See ADR `0003-shader-dsl-single-emit`.
- **earcut runs in Mercator-projected coordinates** so triangle edges match the GPU. Projections switch via a GPU uniform — never re-tessellate per projection.
- **DSFUN split-precision packing** (high+low f32 pairs) recovers camera-relative metres at ~f64 precision; tiles pack ECEF metres. See ADR `0001-ecef-tile-pipeline`.
- **Tile selection + GPU budget is bug-prone.** `data/tile-select.ts`, `loader/tiles-sse.ts`, `data/tile-catalog.ts`, and the VTR per-tile loop interact through implicit budgets (upload/frame, GPU-cache LRU byte-aware eviction, SSE). Gate any change on concrete e2e tile/perf numbers vs a Mercator control.
- `bun run build` typechecks the workspace; `bun run test` (vitest) does NOT typecheck. Always build before committing type-affecting changes.
- God-object caveat: `map/src/render/vector-tile-renderer.ts`, `map/src/map.ts`, and `map/src/text/text-stage.ts` own state that should be distributed — documented #1 architectural debt in `docs/architecture/MODULES.md §4`. Do not assume these files are cleanly layered.

### Testing Requirements

- Colocated `*.test.ts` (vitest) throughout `src/`. Run via `bun run test` from the repo root.
- `src/__test-support__/` provides WebGPU stubs; `src/__tests__/` holds integration-level tests. Neither directory's internals should be enumerated in file listings.
- Perf, tile-selection, and projection changes additionally gate on Playwright suites in `playground/`: `test:pixel`, `test:perf`, `test:projection`, `test:e2e`.
- CI runs no-GPU pure-compute/WGSL-compile gates under SwiftShader only. Render-correctness (pixel-match) runs locally on a real GPU. See ADR `0004-verification-gate-strategy` and `docs/verification/STRATEGY.md`.

### Common Patterns

- `// ═══ Title ═══` banner comments head most modules; many carry Korean section headers in larger files.
- Pure logic is extracted from GPU classes into GPU-free sibling modules (e.g. `line-segment-build.ts`, `polygon-mesh.ts`, `tile-decision.ts`, `bucket-scheduler.ts`) for testability; the GPU class re-exports the public surface.
- Worker pools (GeoJSON tiling, MVT decode) live in `@xgis/data` and communicate via structured-clone messages; Vite emits them as sibling chunks in `dist/`.

## Dependencies

### Internal (workspace, bundled into `dist/`)

- `@xgis/map` — XGISMap, the renderers, camera, text/sprite stages, color ramps (the bulk of the bundle).
- `@xgis/data` — tile catalog/sources, loaders, GeoJSON + polar-cap helpers, worker pools.
- `@xgis/geo` — the projection factories re-exported by the barrel.
- `@xgis/rhi-webgpu` — `ComputeDispatcher` (the one export the barrel takes from a backend).
- `@xgis/engine`, `@xgis/rhi`, `@xgis/compiler`, `@xgis/shader-dsl`, `@xgis/shared` — pulled in transitively and bundled.

### External

- `pmtiles` — PMTiles archive reader.
- `proj4` — EPSG input-data reprojection (**user-approved zero-dep-policy exception**, input side only; the eight display projections remain hand-written via the shader DSL).
- `earcut` — polygon triangulation (exposed via `src/earcut.d.ts`).
- `pbf`, `@mapbox/vector-tile` — MVT decode (imported by the bundled-in compiler; kept external so the consumer resolves them).
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
projections remain hand-written in `@xgis/geo` / the shader DSL and are untouched.

The EPSG def registry lives at `data/src/sources/epsg-defs.ts` (registers
codes proj4 does not bundle — currently EPSG:5179 / 5186 — and throws a clear
error for unregistered/invalid codes). Its AC0 precision spike pinned the
cross-validation tolerance at **1e-3 m (1mm), measured at EPSG:3857 meters**
(actual proj4js↔pyproj divergence ≈ 3.7e-9 m).
