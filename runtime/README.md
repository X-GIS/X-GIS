# @xgis/runtime

The **published distribution** of X-GIS. `@xgis/runtime` is the only package in the
monorepo that ships to npm: it is a thin public barrel that re-exports the map facade
(`@xgis/map`), the data/loader surface (`@xgis/data`), the projection factories
(`@xgis/geo`) and the compute dispatcher (`@xgis/rhi-webgpu`), and bundles all of them
into one `dist/`. Its own source is ~1.8k LOC: the barrel, the runtime capability table,
and the `<xgis-map>` custom element.

> The rendering itself lives elsewhere. `@xgis/compiler` turns `.xgis` source into IR +
> scene commands; `@xgis/map` owns the renderers, camera, text/sprite stages and the
> vector-tile pipeline; `@xgis/engine` owns the content-blind GPU primitives; the RHI
> backends are `@xgis/rhi-webgpu` / `@xgis/rhi-webgl2`. See
> [`docs/architecture/OVERVIEW.md`](../docs/architecture/OVERVIEW.md) for the C4 view and
> [`docs/architecture/MODULES.md`](../docs/architecture/MODULES.md) for the module DAG.

## WebGPU-only

The rendering backend is **WebGPU-only**. When `navigator.gpu` or a GPU adapter
is absent, `initGPU` throws `WebGPUUnavailableError` and the map fires
`onWebGPUUnavailable()` and simply does not mount — there is **no live Canvas 2D
render path** in `runtime/src/`. This is a recorded decision; see the WebGPU-only
note in [`docs/adr/README.md`](../docs/adr/README.md). (The root `README.md`
mentions a Canvas 2D fallback as an aspiration; it is not built.)

## Install / import

```bash
npm install @xgis/runtime
```

```ts
import { XGISMap } from '@xgis/runtime'
```

Apps import only from the package barrel (`@xgis/runtime`), never from internal
paths.

## Public API

The public surface is the `src/index.ts` barrel. The entry point is `XGISMap`.

```ts
import { XGISMap } from '@xgis/runtime'

const map = new XGISMap(canvas, options) // options: glyphs, spriteUrl, fonts, ...
await map.run(xgisSource, baseUrl) // compile + load + render an .xgis string
// or:
await map.load(url) // fetch + auto-detect .xgis vs .xgb
```

`new XGISMap(canvas, options)` wires the camera, controllers, and source
manager; the GPU context, renderers, and per-frame loop are created lazily on
the first `run()`/`load()` (which is where `initGPU` may throw if WebGPU is
unavailable).

For HTML hosts, the `<xgis-map>` custom element wraps `XGISMap`: it owns a
shadow-DOM canvas and dispatches its `src` attribute / inline text to
`map.load` / `map.run`.

Top-level exports from `index.ts`:

| Export                                                                                                   | What                                                                               |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `XGISMap`                                                                                                | Top-level map orchestrator (compile → load → camera-fit → frame loop).             |
| `XGISMapElement`, `registerXGISElement`                                                                  | `<xgis-map>` web component + registration.                                         |
| `Camera`                                                                                                 | Zoom/pan/bearing/pitch, MVP matrix, log-depth FC.                                  |
| `MapRendererContent`, `FrameRenderer`                                                                    | The content renderer + the per-frame driver behind `XGISMap`.                      |
| `loadGeoJSON`, `lonLatToMercator`                                                                        | GeoJSON ingest + Mercator helper.                                                  |
| `mercator`, `equirectangular`, `naturalEarth`, `orthographic`, `getProjection`                           | Projection factories (CPU `{forward, inverse}`).                                   |
| `VectorTileLoader`, `VectorTileSource`, `PMTilesArchiveSource`, `TileJSONSource`, `loadPMTilesSource`, … | Vector-tile / PMTiles source surface.                                              |
| `synthesizePolarCaps`, `injectPolarCaps`, `projectionNeedsPolarCaps`, …                                  | Polar-cap synth/detect (data preprocessing utility; no longer renderer-driven).    |
| `ComputeDispatcher`                                                                                      | Per-feature expression compute kernel dispatcher.                                  |
| `createColorRampTexture`, `createRampSampler`, `availableRamps`                                          | Data-driven color-ramp LUTs.                                                       |
| `RUNTIME_CAPABILITIES`, `runtimeCapability`, `runtimeGaps`                                               | Per `(layerType, property, variant)` matrix of what the renderer actually honours. |
| `StatsPanel`, `StatsTracker`                                                                             | Per-frame fps/draws/tris/tiles metrics.                                            |

## Source layout

`src/` holds only the publication layer. Everything it exposes is implemented in a
sibling package.

| Path                                            | One-line                                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                      | The public barrel — re-exports from `@xgis/map`, `@xgis/data`, `@xgis/geo`, `@xgis/rhi-webgpu`, plus the capability table and the custom element.              |
| `capabilities/`                                 | Per-layer-type capability descriptors (`background`, `circle`, `fill`, `fill-extrusion`, `heatmap`, `line`, `raster`, `symbol`) spread into `capabilities.ts`. |
| `capabilities.ts`                               | `RUNTIME_CAPABILITIES` — per `(layerType, property, variant)` flags of what the renderer honours vs silently drops.                                            |
| `web/`                                          | `XGISMapElement` / `registerXGISElement` — the `<xgis-map>` custom element.                                                                                    |
| `vite-shims.ts`, `earcut.d.ts`                  | Ambient declarations (Vite's `?worker` query suffix; untyped `earcut`).                                                                                        |
| `test-setup-projections.ts`                     | The root Vitest `setupFiles` entry — calls `configureProjections(PROJECTIONS)` before any suite touches the projection path.                                   |
| `architecture-invariants.test.ts`, `__tests__/` | The three gates runtime owns: the repo-wide structural ratchet, spec-coverage drift, gap-matrix freshness.                                                     |

Cross-cutting design notes live with the code they describe:

- **CPU↔GPU projection parity is a hard contract** — the CPU mirror is generated from the
  shader DSL, never hand-maintained. ADR [0003](../docs/adr/0003-shader-dsl-single-emit.md).
- **earcut runs in Mercator-projected coordinates** so triangle edges match the GPU;
  projections switch via a GPU uniform, never re-tessellation.
- **DSFUN** split-precision packing recovers camera-relative metres at ~f64 precision on
  f32 hardware — ADR [0001](../docs/adr/0001-ecef-tile-pipeline.md).

> **God-object caveat:** the largest classes (`map/src/render/vector-tile-renderer.ts`,
> `map/src/map.ts`, `map/src/text/text-stage.ts`) own state that should be distributed —
> the project's #1 architectural debt, tabled in
> [`docs/architecture/MODULES.md`](../docs/architecture/MODULES.md) §4. They live in
> `@xgis/map`, not here.

## Build / test

The package defines a `build` script that produces the published, single-bundled
`dist/` (Vite lib build + `scripts/build-dts.ts` for the rolled-up declarations);
typecheck and test run from the repo root:

```bash
bun run --filter @xgis/runtime build   # build the publishable dist/ (JS + bundled .d.ts)
bun run build   # typechecks the workspace — run before commits; vitest does NOT typecheck
bun run test    # root `vitest run` — runs the WHOLE monorepo's *.test.ts (not runtime-only)
```

Perf, tile-selection, and
projection changes additionally gate on Playwright suites driven by **root-level**
scripts (run from the repo root, which `cd`s into `playground/`):
`test:pixel`, `test:perf`, `test:projection`, plus `test:e2e` (defined in
`playground/package.json`). CI runs only no-GPU pure-compute/WGSL-compile gates under
SwiftShader; render-correctness runs local on a real GPU — see ADR
[0004 — verification gate strategy](../docs/adr/0004-verification-gate-strategy.md)
and [`docs/verification/STRATEGY.md`](../docs/verification/STRATEGY.md).

## Dependencies

Every internal `@xgis/*` package the barrel reaches — `map`, `data`, `geo`, `engine`,
`rhi`, `rhi-webgpu`, `compiler`, `shader-dsl`, `shared` — is `private: true` and is
**bundled into `dist/`** at build time (they are absent from vite's `EXTERNAL` list), so
they are devDependencies here and the published package depends only on genuine
third-party externals:

- **Runtime:** `@mapbox/vector-tile` + `pbf` (MVT decode), `pmtiles` (archive
  reader), `earcut` (polygon tessellation), `proj4` (EPSG input-data reprojection
  — a user-approved [zero-dep-policy exception](./AGENTS.md), input side only; the
  seven display projections stay hand-written), and `@webgpu/types` (ambient
  WebGPU type globals referenced by the shipped `.d.ts`).
- **Dev:** `geojson-vt`, `vt-pbf` (in-memory GeoJSON tiling for the
  virtual-PMTiles path), plus the Vite + `rollup-plugin-dts` build toolchain.

## See also

- [`runtime/AGENTS.md`](./AGENTS.md) — package-level agent notes + zero-dep exception.
- [`docs/architecture/OVERVIEW.md`](../docs/architecture/OVERVIEW.md) — C4 architecture.
- [`docs/architecture/MODULES.md`](../docs/architecture/MODULES.md) — module DAG + god-object table.
- [`docs/architecture/diagrams/`](../docs/architecture/diagrams/) — UML sequence/class/state diagrams (frame render, tile lifecycle, projection modes, …).
- [`docs/adr/`](../docs/adr/) — accepted decisions (ECEF, geoid split, shader DSL, verification, background, world-copy, WebGPU-only).
