# @xgis/runtime

The WebGPU rendering engine for X-GIS. `@xgis/runtime` is the rendering half of
the monorepo: it consumes the compiler's output (`SceneCommands`,
`ShaderVariant`, `CompiledTile`) and paints maps on the GPU. It owns the camera
math, pointer interaction, the full MVT/PBF vector-tile pipeline, and the seven
projections — each baked into WGSL with a paired CPU implementation.

> Role in the monorepo: `@xgis/compiler` turns `.xgis` source into IR + scene
> commands + shaders; `@xgis/runtime` executes them on WebGPU. See
> [`docs/architecture/OVERVIEW.md`](../docs/architecture/OVERVIEW.md) for the C4
> view and [`docs/architecture/MODULES.md`](../docs/architecture/MODULES.md) for
> the module DAG.

## WebGPU-only

The rendering backend is **WebGPU-only**. When `navigator.gpu` or a GPU adapter
is absent, `initGPU` throws `WebGPUUnavailableError` and the map fires
`onWebGPUUnavailable()` and simply does not mount — there is **no live Canvas 2D
render path** in `runtime/src/`. This is a recorded decision; see the WebGPU-only
note in [`docs/adr/README.md`](../docs/adr/README.md). (The root `README.md`
mentions a Canvas 2D fallback as an aspiration; it is not built.)

## Install / import

Workspace package (`"private": true`), consumed inside the bun monorepo:

```jsonc
// package.json
"dependencies": { "@xgis/runtime": "workspace:*" }
```

Apps import only from the package barrel (`@xgis/runtime`), never from internal
paths.

## Public API

The public surface is the `src/index.ts` barrel. The entry point is `XGISMap`.

```ts
import { XGISMap } from '@xgis/runtime'

const map = new XGISMap(canvas, options) // options: glyphs, spriteUrl, fonts, ...
await map.run(xgisSource, baseUrl)        // compile + load + render an .xgis string
// or:
await map.load(url)                        // fetch + auto-detect .xgis vs .xgb
```

`new XGISMap(canvas, options)` wires the camera, controllers, and source
manager; the GPU context, renderers, and per-frame loop are created lazily on
the first `run()`/`load()` (which is where `initGPU` may throw if WebGPU is
unavailable).

For HTML hosts, the `<xgis-map>` custom element wraps `XGISMap`: it owns a
shadow-DOM canvas and dispatches its `src` attribute / inline text to
`map.load` / `map.run`.

Top-level exports from `index.ts`:

| Export | What |
|--------|------|
| `XGISMap` | Top-level map orchestrator (compile → load → camera-fit → frame loop). |
| `XGISMapElement`, `registerXGISElement` | `<xgis-map>` web component + registration. |
| `Camera` | Zoom/pan/bearing/pitch, MVP matrix, log-depth FC. |
| `MapRenderer` | WebGPU renderer for compiled GeoJSON meshes. |
| `loadGeoJSON`, `lonLatToMercator` | GeoJSON ingest + Mercator helper. |
| `mercator`, `equirectangular`, `naturalEarth`, `orthographic`, `getProjection` | Projection factories (CPU `{forward, inverse}`). |
| `VectorTileLoader`, `VectorTileSource`, `PMTilesArchiveSource`, `TileJSONSource`, `loadPMTilesSource`, … | Vector-tile / PMTiles source surface. |
| `synthesizePolarCaps`, `injectPolarCaps`, `projectionNeedsPolarCaps`, … | Polar-cap synth/detect (data preprocessing utility; no longer renderer-driven). |
| `ComputeDispatcher` | Per-feature expression compute kernel dispatcher. |
| `createColorRampTexture`, `createRampSampler`, `availableRamps` | Data-driven color-ramp LUTs. |
| `RUNTIME_CAPABILITIES`, `runtimeCapability`, `runtimeGaps` | Per `(layerType, property, variant)` matrix of what the renderer actually honours. |
| `StatsPanel`, `StatsTracker` | Per-frame fps/draws/tris/tiles metrics. |

## Subsystems

Source lives under `src/`, split into four subsystem dirs plus support modules.
Each has a per-directory `AGENTS.md` with the detail.

| Subsystem | One-line | Detail |
|-----------|----------|--------|
| `engine/` | `XGISMap` orchestrator, DOM-style layer API, AST interpreter, interaction, stats. | [src/engine/AGENTS.md](./src/engine/AGENTS.md) |
| `engine/render/` | Every draw-call renderer (vector tiles, lines, points, raster, background) + scheduling. | [src/engine/render/AGENTS.md](./src/engine/render/AGENTS.md) |
| `engine/gpu/` | WebGPU device/context, shared blend/stencil constants, uniform/staging buffers, compute dispatch. | [src/engine/gpu/AGENTS.md](./src/engine/gpu/AGENTS.md) |
| `engine/projection/` | Camera + the 7 CPU projections (projType 0–6) + true-3D globe (projType 7). | [src/engine/projection/AGENTS.md](./src/engine/projection/AGENTS.md) |
| `engine/shader-dsl/` | In-house TSL-inspired DSL: one IR emits both WGSL and the CPU-f64 mirror (kills GPU↔CPU drift). | [src/engine/shader-dsl/AGENTS.md](./src/engine/shader-dsl/AGENTS.md) |
| `engine/shaders/` | Shared WGSL string blocks (projection, log-depth, SDF). | [src/engine/shaders/AGENTS.md](./src/engine/shaders/AGENTS.md) |
| `engine/text/` | SDF text/label pipeline: shaping, collision, atlas, rasterisers. | [src/engine/text/AGENTS.md](./src/engine/text/AGENTS.md) |
| `engine/sprite/` | Sprite/icon atlas + icon renderer + stage. | [src/engine/sprite/AGENTS.md](./src/engine/sprite/AGENTS.md) |
| `data/` | `TileCatalog` router/cache, per-format `TileSource` backends, decode worker pools, filter/extrude eval. | [src/data/AGENTS.md](./src/data/AGENTS.md) |
| `loader/` | GeoJSON loader, `VectorTileLoader`, SSE tile selector, polar-cap detect. | [src/loader/AGENTS.md](./src/loader/AGENTS.md) |
| `core/` | GPU-free geometry/scheduling primitives (line-segment build, polygon mesh, priority queue). | [src/core/AGENTS.md](./src/core/AGENTS.md) |
| `web/` | `<xgis-map>` custom element. | [src/web/AGENTS.md](./src/web/AGENTS.md) |

Cross-cutting design notes worth knowing before editing:

- **CPU↔GPU projection parity is a hard contract.** The CPU mirror of the WGSL
  projections is GENERATED from the shader DSL (`engine/shader-dsl`), not hand-
  maintained. See ADR [0003 — shader DSL single-emit](../docs/adr/0003-shader-dsl-single-emit.md).
- **earcut runs in Mercator-projected coordinates** so triangle edges match the
  GPU; projections switch via a GPU uniform, never re-tessellation.
- **DSFUN** (double-single float) split-precision packing recovers camera-
  relative metres at ~f64 precision on f32 hardware; tiles pack ECEF metres —
  ADR [0001 — ECEF tile pipeline](../docs/adr/0001-ecef-tile-pipeline.md).

> **God-object caveat:** the engine's largest classes (`VectorTileRenderer`,
> `map.ts`, the tiler, `text-stage`, …) own state that should be distributed —
> this is the project's #1 architectural debt and is documented (with the full
> table) in [`docs/architecture/MODULES.md`](../docs/architecture/MODULES.md)
> §4. Decomposition is planned but unexecuted; do not assume these files are
> cleanly layered.

## Build / test

Scripts run from the repo root (the package defines no scripts of its own; build
and test are workspace-level):

```bash
bun run build   # typechecks the workspace — run before commits; vitest does NOT typecheck
bun run test    # root `vitest run` — runs the WHOLE monorepo's *.test.ts (not runtime-only)
```

`runtime/package.json` defines no scripts of its own. Perf, tile-selection, and
projection changes additionally gate on Playwright suites driven by **root-level**
scripts (run from the repo root, which `cd`s into `playground/`):
`test:pixel`, `test:perf`, `test:projection`, plus `test:e2e` (defined in
`playground/package.json`). CI runs only no-GPU pure-compute/WGSL-compile gates under
SwiftShader; render-correctness runs local on a real GPU — see ADR
[0004 — verification gate strategy](../docs/adr/0004-verification-gate-strategy.md)
and [`docs/verification/STRATEGY.md`](../docs/verification/STRATEGY.md).

## Dependencies

- **Internal:** `@xgis/compiler` (scene commands, shader variants, MVT decode/
  compile, geojson-vt port, expression `evaluate`), `@xgis/shared`.
- **External:** `pmtiles` (archive reader), `@chenglou/pretext` (text layout),
  `proj4` (EPSG input-data reprojection — a user-approved
  [zero-dep-policy exception](./AGENTS.md), input side only; the seven display
  projections stay hand-written). Dev: `geojson-vt`, `vt-pbf` (in-memory GeoJSON
  tiling for the virtual-PMTiles path).

## See also

- [`runtime/AGENTS.md`](./AGENTS.md) — package-level agent notes + zero-dep exception.
- [`docs/architecture/OVERVIEW.md`](../docs/architecture/OVERVIEW.md) — C4 architecture.
- [`docs/architecture/MODULES.md`](../docs/architecture/MODULES.md) — module DAG + god-object table.
- [`docs/architecture/diagrams/`](../docs/architecture/diagrams/) — UML sequence/class/state diagrams (frame render, tile lifecycle, projection modes, …).
- [`docs/adr/`](../docs/adr/) — accepted decisions (ECEF, geoid split, shader DSL, verification, background, world-copy, WebGPU-only).
