# Architecture Overview — C4 Level 1 & 2

System Context (L1) and Container (L2) views of X-GIS, using the
[C4 model](https://c4model.com/). L1 frames X-GIS as one system with its
actors and external dependencies; L2 opens the box into the five workspace
packages and the `.xgis` → tiles → GPU data flow.

This document is grounded in the real codebase. Every claim traces to a file
read at authoring time (cited inline). For the next level down — the render
subsystem class diagram — see
[`diagrams/class-render-subsystem.md`](./diagrams/class-render-subsystem.md).
For the coordinate-space contract the tile pipeline obeys, see
[`../COORDINATES.md`](../COORDINATES.md).

---

## What X-GIS is

A domain-specific language and WebGPU rendering engine for GIS maps — "HTML/CSS
for maps." A `.xgis` source declares **what** data looks like (sources, layers,
Tailwind-style utility classes, presets, functions, symbols); the compiler
decides **how** to render it on the GPU, emitting WGSL shaders, buffer layouts,
and render strategies (`README.md`; root `AGENTS.md` lines 4-6). WebGPU is the
primary renderer; the project also ships a paired CPU projection path for math
parity (`runtime/AGENTS.md` line 7).

It renders vector and raster tiles across eight shader-baked projection slots
(`mercator`, `equirectangular`, `natural_earth`, `orthographic`,
`azimuthal_equidistant`, `stereographic`, `oblique_mercator`, and the true-3D
`globe`) — `runtime/src/engine/projection/projections-table.ts:87-96`. Each
projType is the `proj_params.x` wire value the shaders read, and switching is a
GPU uniform change with no re-tessellation (`runtime/AGENTS.md` line 27).

---

## C4 Level 1 — System Context

### Actors

| Actor | Interacts via | Grounded in |
|-------|---------------|-------------|
| **App developer** (embeds the map) | `XGISMap` public API / `<xgis-map>` web component | `runtime/src/index.ts:1,28` (`XGISMap`, `registerXGISElement`) |
| **Style author** (writes `.xgis`) | `.xgis` source text → compiler | `README.md` "Language" section; `compiler/src/index.ts` (Lexer/Parser/lower) |
| **Playground / demo user** | Vite dev app at `localhost:3000` | `package.json:14` (`dev`); `README.md:35` |
| **Site visitor** | Astro marketing/docs site | `site/package.json` (`astro dev/build`) |
| **Blueprint author** | Visual node editor (schema-derived) | `blueprint/src/index.ts:1-4` |

### External dependencies

X-GIS does not run in a vacuum — at runtime it talks to:

| Dependency | Role | Grounded in |
|-----------|------|-------------|
| **WebGPU (`navigator.gpu`)** | Primary render target; a `GPUDevice` is assumed by all renderers | `runtime/AGENTS.md` line 24 |
| **PMTiles archives** | HTTP vector-tile source (single-file archive) | `runtime/package.json:14` (`pmtiles`); `runtime/src/index.ts:19-27` |
| **MVT / PBF tiles** | Wire format decoded into features (also produced in-worker for GeoJSON) | `compiler/src/index.ts:81` (`decodeMvtTile`); `compiler/package.json:13` (`@mapbox/vector-tile`, `pbf`) |
| **TileJSON manifests** | Tile-source descriptor (URL template + metadata) | `runtime/src/index.ts:24` (`TileJSONSource`) |
| **Sprite / glyph servers** | Icon atlas + PBF glyph ranges for labels | `runtime/src/engine/map.ts:43-45` (`TextStage`, `GlyphProvider`, `IconStage`) |
| **Source GeoJSON** | In-memory `FeatureCollection` upstream (tiled in-worker) | `runtime/src/index.ts:5` (`loadGeoJSON`); `README.md:167-189` |

```
                          ┌───────────────────────────────┐
   .xgis source           │                               │
   ─────────────▶         │                               │
   style author           │            X-GIS              │       ┌──────────────────┐
                          │  (DSL compiler + WebGPU       │──────▶│  WebGPU device   │
   embed / API            │   GIS rendering engine,       │ draw  │  (navigator.gpu) │
   ─────────────▶         │   8 projections + globe)      │       └──────────────────┘
   app developer          │                               │
                          │                               │       ┌──────────────────┐
   open demo              │                               │──────▶│ PMTiles / MVT /  │
   ─────────────▶         │                               │ fetch │ TileJSON sources │
   playground / site      │                               │       └──────────────────┘
                          │                               │
                          │                               │       ┌──────────────────┐
                          │                               │──────▶│ sprite / glyph   │
                          │                               │ fetch │ servers          │
                          └───────────────────────────────┘       └──────────────────┘
```

---

## C4 Level 2 — Containers

The repo is a Bun monorepo with five workspace packages plus a shared support
package (`package.json:6` — `["shared", "compiler", "blueprint", "runtime",
"playground", "site"]`). The dependency direction is strictly downward:
consumers depend on `compiler` / `runtime`, never the reverse.

### Containers

| Container | Responsibility | Key external deps | Grounded in |
|-----------|----------------|-------------------|-------------|
| **`@xgis/compiler`** | Pure-TS front end: Lexer → Parser → AST → `lower()` → IR `Scene` → `optimize()` → `emitCommands()` + WGSL codegen. **No GPU dependency** — WGSL is emitted as strings. Also hosts the Mapbox/MapLibre style importer (`convert/`) and the data-side vector tiler (`tiler/`). | `@mapbox/vector-tile`, `pbf` | `compiler/AGENTS.md` lines 6-7,26; `compiler/package.json` |
| **`@xgis/runtime`** | The engine. Consumes compiler output (SceneCommands, ShaderVariant, CompiledTile) and paints on the GPU. Owns the WebGPU renderers, camera math, pointer interaction, and the full MVT/PBF tile pipeline. | `pmtiles`, `proj4`, `@chenglou/pretext` | `runtime/AGENTS.md` lines 6-7; `runtime/package.json` |
| **`@xgis/blueprint`** | Standalone, framework-agnostic visual node editor for authoring `.xgis` maps. Node catalogue is **derived from** the compiler's `LANGUAGE_SCHEMA` so it tracks the language. | `@xgis/compiler` only | `blueprint/src/index.ts:1-4`; `blueprint/package.json` |
| **`@xgis/shared`** | Shared support code consumed by compiler + runtime. | (none) | `package.json:6`; `compiler/package.json:13`, `runtime/package.json:12` |
| **`@xgis/playground`** | Vite dev app + Playwright e2e (pixel-match survey, perf, projection coverage). Consumes both compiler + runtime; pulls in `maplibre-gl` only as an e2e comparison control. | `vite`, `@playwright/test`, `maplibre-gl`, `pixelmatch` | `playground/package.json`; root `AGENTS.md` line 27 |
| **`@xgis/site`** | Astro marketing/docs site. Consumes compiler, runtime, **and** blueprint. | `astro`, `tailwindcss` | `site/package.json` |

> Note: `README.md:130-136` lists "three packages" (compiler / runtime /
> playground) — that table predates the `blueprint`, `shared`, and `site`
> workspaces now present in `package.json:6`. The six-container list above
> reflects the current workspace set.

### Container diagram

```
  STYLE AUTHOR                         APP DEVELOPER / PLAYGROUND / SITE
       │ .xgis source                            │  XGISMap API / <xgis-map>
       ▼                                         ▼
 ┌──────────────────────────────────┐    ┌────────────────────────────────────────┐
 │        @xgis/compiler            │    │             @xgis/runtime               │
 │        (pure TS, no GPU)         │    │             (WebGPU engine)             │
 │                                  │    │                                         │
 │  Lexer ─▶ Parser ─▶ AST          │    │   XGISMap  (entry point / facade)       │
 │              │                   │    │      │  interpret(SceneCommands)        │
 │           lower()                │    │      ▼                                  │
 │              │                   │    │   SourceManager ─▶ tile pipeline:       │
 │           IR (Scene)             │    │      PMTiles / TileJSON / GeoJSON        │
 │              │                   │    │      ─▶ decodeMvtTile ─▶ decompose       │
 │     optimize()  (IR passes:      │    │      ─▶ compileSingleTile (earcut in MM) │
 │      const-fold, classify,       │    │      ─▶ DSFUN / ECEF GPU buffers         │
 │      CSE, deps)                  │    │      │                                  │
 │              │                   │    │   Camera ──┐                            │
 │      ┌───────┴────────┐          │    │      ▼     ▼                            │
 │  emitCommands()   codegen        │    │   RenderLoop ─▶ passes:                 │
 │      │            (ShaderVariant │    │      opaque ▶ oit ▶ translucent ▶       │
 │      │             [], compute,  │    │      points ▶ label ▶ overdraw-compose  │
 │      │             palette)      │    │         │                               │
 │      ▼                ▼          │    │         ▼                               │
 │  SceneCommands ── ShaderVariant ─┼───▶│   VectorTileRenderer / MapRenderer /    │
 │                                  │    │   LineRenderer / PointRenderer /        │
 │  convert/  (Mapbox→.xgis import) │    │   TextStage / IconStage ─▶ WGSL draw    │
 │  tiler/    (geojson-vt port)     │    │                                         │
 └──────────────────────────────────┘    └────────────────────────────────────────┘
        ▲              ▲                              ▲
        │ LANGUAGE_    │ SceneCommands /              │  pmtiles / proj4 /
        │ SCHEMA       │ ShaderVariant /              │  @chenglou/pretext
        │              │ CompiledTile / tiler         │
 ┌──────┴───────┐      └──────────────────────────────┘
 │@xgis/blueprint│
 │ (node editor) │     @xgis/shared ── consumed by compiler + runtime
 └───────────────┘     @xgis/site ── consumes compiler + runtime + blueprint
```

---

## Data flow: `.xgis` → pixels

### 1. Compile (`@xgis/compiler`, GPU-free)

The compile-pipeline order is load-bearing and must not be reordered
(`compiler/AGENTS.md` line 27). Public entry points from `compiler/src/index.ts`:

1. **`Lexer` → `Parser` → AST** — `index.ts:1,3,4`.
2. **`lower(ast)` → IR `Scene`** — `index.ts:8`. The `Scene` /`RenderNode` IR
   types are `index.ts:10`.
3. **`optimize(scene)`** — `index.ts:26`. Runs the IR pass manager:
   constant folding, expression classification, CSE, deps annotation
   (`compiler/src/ir/`: `const-fold.ts`, `classify.ts`, `passes/cse.ts`,
   `passes/annotate-deps.ts`; exported at `index.ts:86-89`). Three execution
   classes drive the design — `constant` (folded), `zoom-dependent`
   (CPU-interpolated per frame), and `per-feature-gpu` (WGSL codegen) —
   `compiler/AGENTS.md` line 28; `README.md:148-156`.
4. **Two outputs from the optimized `Scene`:**
   - `emitCommands(scene)` → **SceneCommands** for the runtime (`index.ts:9`).
   - codegen → **`ShaderVariant[]`** plus compute kernels and palettes
     (`index.ts:27`, `33`, `40`). A `ShaderVariant` carries a pipeline cache
     `key` and a WGSL `preamble`
     (`compiler/src/codegen/shader-gen-types.ts:13-21`).

The **vector tiler** lives compiler-side too (`tiler/`, `tiler/geojsonvt/`):
`compileGeoJSONToTiles`, `compileSingleTile`, `decomposeFeatures`,
`decodeMvtTile`, plus the geojson-vt port (`index.ts:70-82`). Key invariant:
**earcut runs in Mercator-projected coordinates** so triangle edges match GPU
rendering (`README.md:191-196`; `compiler/AGENTS.md` summary). The full
coordinate-space contract (LL / MM / DLM / SP) is in
[`../COORDINATES.md`](../COORDINATES.md).

### 2. Render (`@xgis/runtime`, WebGPU)

`XGISMap` is the entry point that wires everything
(`runtime/src/engine/map.ts:1,96`). It runs the compiler in-process
(`map.ts:5` imports `Lexer, Parser, lower, optimize, emitCommands` from
`@xgis/compiler`), then:

1. **`interpret(...)` → SceneCommands → shows** — `map.ts:35`
   (`interpret`, `SceneCommands`). The interpreter bridges
   compiler SceneCommands to renderer `ShowCommand`s
   (`runtime/src/engine/interpreter.ts:1,6`).
2. **`SourceManager`** drives the tile pipeline — PMTiles / TileJSON archives or
   in-memory GeoJSON, through the single MVT decode + compile path
   (`map.ts:23,51-52`; `runtime/AGENTS.md` line 7). Vertices land in DSFUN
   (split-precision f32 hi/lo) or ECEF GPU buffers (`runtime/AGENTS.md`
   lines 41-49; `compiler/src/index.ts:70`).
3. **`Camera`** supplies the per-projection view matrix
   (`map.ts:21`; `Camera.getViewForProjection` per
   `diagrams/class-render-subsystem.md:77`).
4. **`RenderLoop.render`** drives a fixed per-frame pass chain
   (`runtime/src/engine/render-loop.ts:463-479`):

   ```
   opaquePass ─▶ oitPass ─▶ translucentPass ─▶ pointsPass ─▶ labelPass ─▶ overdrawComposePass
   ```

   `oit`, `translucent`, `points`, and `overdraw-compose` are gated by
   `shouldRun(scene)`; `opaque` and `label` always run (`render-loop.ts:463-479`).
5. The passes reach the renderers — `VectorTileRenderer`, `MapRenderer`,
   `LineRenderer`, `PointRenderer`, `TextStage`, `IconStage` — through a typed
   `RenderLoopHost` view of `XGISMap`'s members
   (`render-loop.ts:45-90`; pass imports `render-loop.ts:28-33`). These issue
   the actual WGSL `drawIndexed` calls.

### CPU↔GPU projection parity (hard contract)

Each projection has paired CPU and GPU implementations that must agree exactly.
The CPU side is `engine/projection/projection.ts`; the WGSL side is the source
of truth (`engine/shaders/projection.ts`), and a **generated** CPU-f64 lowering
(`engine/shader-dsl/cpu-projections.ts`) is produced from the projection IR
(`engine/shader-dsl/projections.ts`). Divergences here are a documented
recurring bug class (`runtime/AGENTS.md` line 25). The
`projections-table.ts` `PROJECTIONS` array is the single source of truth for
`projType → behavior` that every projection-aware site derives from
(`projections-table.ts:1-21,87-96`).

---

## Self-audit — files cited to ground this doc

- **Container list + responsibilities + deps** — read all six `package.json`
  files (`package.json` root workspaces list; `compiler/`, `runtime/`,
  `blueprint/`, `shared/`, `playground/`, `site/`) plus root `AGENTS.md`,
  `compiler/AGENTS.md`, `runtime/AGENTS.md` for purpose statements.
- **Compile pipeline + outputs** — `compiler/src/index.ts` (public exports:
  `lower`/`optimize`/`emitCommands`/codegen/tiler), `compiler/AGENTS.md`
  (pipeline order, three exec classes), `compiler/src/codegen/shader-gen-types.ts`
  (`ShaderVariant` shape).
- **Render flow + pass chain** — `runtime/src/index.ts` (public barrel),
  `runtime/src/engine/map.ts` (XGISMap wiring + compiler import + interpret),
  `runtime/src/engine/render-loop.ts:28-90,463-479` (RenderLoopHost +
  ordered pass chain + `shouldRun` gating).
- **Projections (8 slots) + parity contract** —
  `runtime/src/engine/projection/projections-table.ts:87-96` (PROJECTIONS array,
  projType 0-7), `runtime/AGENTS.md:25` (CPU↔GPU mirror contract).
- **External deps + tiler invariant** — `runtime/package.json` /
  `compiler/package.json` (pmtiles/proj4/pretext, vector-tile/pbf),
  `README.md:167-196` (vector-tile pipeline + earcut-in-Mercator),
  `docs/COORDINATES.md` (coordinate-space contract) for the data-flow notes.
- **Reused existing doc** — `docs/architecture/diagrams/class-render-subsystem.md`
  for the L3 cross-reference and `Camera.getViewForProjection` signature
  (omitted the `MODULES.md` / `adr/` / `sequence-frame-render.md` references that
  doc makes, because those files do not yet exist in the repo).
