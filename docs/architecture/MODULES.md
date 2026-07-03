# Module dependency map

Last revised: 2026-06-02 (paths refreshed 2026-06-29 for the `@xgis/shader-dsl`
package extraction).

This document maps the import-direction DAG of X-GIS: the cross-package
layering (`compiler → runtime`, acyclic) and the engine subsystem graph
inside `runtime/src/engine/`. It also names the six god-objects that
dominate the engine and the unexecuted decomposition plan that targets them.

It is a **map**, not a tutorial. Every edge below is an actual `import`
direction in the source — verified, not aspirational. When the code moves,
this file is wrong; treat a divergence as a doc bug.

---

## 1. Package DAG

Five published workspaces (`shared`, `shader-dsl`, `compiler`, `runtime`, plus
the `blueprint` editor) plus consumers. `@xgis/shader-dsl` is a zero-dep leaf,
imported by both `compiler` (codegen) and `runtime`. The arrow is the import
direction (`A → B` = "A imports B").

```
        ┌───────────────┐
        │  @xgis/shared │   ecef.ts — WGS84 / ECEF math (leaf, no deps)
        └───────▲───────┘
                │ imported by BOTH (the shared kernel)
        ┌───────┴────────────────────┐
        │                            │
┌───────┴────────┐          ┌────────┴────────┐
│ @xgis/compiler │  ──────► │  (no edge back) │
│  lexer/parser/ │          │                 │
│  IR/optimizer/ │          │                 │
│  codegen/tiler │          │                 │
└───────▲────────┘          └─────────────────┘
        │ @xgis/runtime imports @xgis/compiler (59 non-test files)
┌───────┴────────┐
│  @xgis/runtime │   engine (XGISMap, renderers, camera, shaders/dsl),
│                │   data (TileCatalog), loader, core
└───────▲────────┘
        │
┌───────┴───────────────────────┐
│ playground / site / blueprint │   consumers (dev app, docs site, editor)
└───────────────────────────────┘
```

Edges, grounded:

- **`runtime → compiler`** — `runtime/src` has 59 non-test files importing
  `@xgis/compiler` (lexer, parser, `lower`, `optimize`, `emitCommands`,
  `ShaderVariant`, `tileKey`, `POLYGON_FILL_FORMAT`, …). Entry point is
  `map.ts:5`.
- **`compiler → runtime`: NONE.** There is still no `@xgis/runtime` import
  inside `compiler/src`; the DAG is acyclic by construction. The codegen WGSL
  emit no longer needs runtime — `compiler/codegen` now imports the IR + emit
  from the zero-dep **`@xgis/shader-dsl`** package (`node-types.ts` imports
  `Expr`/`ShaderType`; `compute-gen.ts` authors kernels through its IR). A
  residual hand copy of the WGSL backend survives test-only in
  `codegen/node-to-wgsl.ts` as an emit-shape oracle (see
  `package-responsibilities.md` §5).
- **`@xgis/shared`** is the shared math kernel (`ecef.ts`, ~9 KB). It is
  imported by both `runtime/src/engine/projection/ecef.ts` (a thin
  `export * from '@xgis/shared'` re-export keeping every `../projection/ecef`
  path stable) and `compiler/src/tiler/vector-tiler.ts`. This re-export
  exists _specifically_ so the tiler and the engine share one ECEF source
  instead of hand-mirroring constants across the package barrier.

---

## 2. Engine subsystem map

`runtime/src/engine/` splits into seven subsystems. Data loading is **not**
under `engine/` — it lives at `runtime/src/data/` (TileCatalog and the tile
backends) and `runtime/src/loader/` (GeoJSON, tile-select). The arrow is the
import direction.

```
                         ┌──────────────────────────────────────────┐
                         │  map.ts  (XGISMap — the wiring hub)       │
                         │  owns: renderers, stages, camera,         │
                         │  controllers, TileCatalog, SourceManager  │
                         └───┬───────────┬───────────┬──────────┬────┘
                             │           │           │          │
          ┌──────────────────┘           │           │          └────────────┐
          ▼                              ▼           ▼                       ▼
   ┌─────────────┐              ┌───────────────┐  ┌─────────────┐   ┌──────────────┐
   │ render-loop │              │   render/     │  │   text/     │   │   sprite/    │
   │  (per-frame │─────────────►│ VTR, MapRend, │  │ TextStage,  │   │ IconStage,   │
   │   delegate) │              │ point/line/   │  │ TextRend,   │   │ IconRend,    │
   └─────────────┘              │ raster rend   │  │ sdf atlas   │   │ sprite atlas │
                                └──┬────┬────┬───┘  └──────┬──────┘   └──────┬───────┘
                                   │    │    │             │                 │
            ┌──────────────────────┘    │    └─────────────┼─────────────────┤
            ▼                           ▼                  ▼                 ▼
     ┌──────────────┐            ┌─────────────┐    ┌──────────────────────────┐
     │  projection/ │◄───────────│   gpu/      │    │      shaders/dsl/        │
     │  camera,     │  (camera   │ gpu-shared, │    │ graphs(polygon,line,     │
     │  globe,      │   imports  │ gpu-arena,  │    │   point,text,sdf,raster, │
     │  projections-│   gpu-     │ frame-arena,│    │   projections, …)        │
     │  table (SoT) │   shared)  │ quality,    │    │ on @xgis/shader-dsl pkg  │
     └──────┬───────┘            │ compute     │    │ index.ts = public barrel │
            │                    └──────┬──────┘    └────────────┬─────────────┘
            │ projections-table         │ gpu-shared re-exports   │ emits WGSL strings
            │ is imported widely        │ the table's derived     │ consumed by render/
            ▼                           ▼ predicates (auth flip)  ▼ + projection shaders
     ┌──────────────────────────────────────────────────────────────────────────┐
     │  data/ (TileCatalog, backends, sub-tiler)  +  loader/ (geojson, tile-     │
     │  select)  +  core/ (polygon-mesh, priority-queue)  — below the engine     │
     └──────────────────────────────────────────────────────────────────────────┘
```

### Subsystem roles and key edges

| Subsystem       | Path                  | Role                                                                                                                                                                                                                                                                                                                                                           | Depends on (import dir)                                                               |
| --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **render**      | `engine/render/`      | GPU buffer/bind-group/draw-call orchestration. `vector-tile-renderer.ts` (VTR), `renderer.ts` (MapRenderer), per-geometry `point/line/raster-renderer`, `bucket-scheduler`, `uniform-ring`, `render-targets`, `bundle-cache`.                                                                                                                                  | `gpu`, `projection`, `shader-dsl`, `data`, `loader`, `core`                           |
| **gpu**         | `engine/gpu/`         | WebGPU device, buffers, arenas, compute, quality. `gpu-shared.ts` holds `WORLD_MERC` / `TILE_PX` and **re-exports the projection table's derived predicates** (`gpu-shared.ts:303`). `gpu-arena`, `frame-arena`, `staging-buffer-pool`, `compute`, `bind-tiers`, `palette-texture`.                                                                            | `projection` (re-export only), shared GPU primitives                                  |
| **projection**  | `engine/projection/`  | Camera math, globe path, forward/inverse maps, and `projections-table.ts` = **single source of truth** (§3). `camera.ts`, `globe.ts`, `projection.ts`, `ecef.ts` (re-export of `@xgis/shared`).                                                                                                                                                                | `gpu/gpu-shared`, `gpu/gpu` (camera imports gpu, not vice-versa)                      |
| **shaders/dsl** | `engine/shaders/dsl/` | WGSL emit authority — the X-GIS shader **graphs** (polygon/line/point/text/sdf/raster/heatmap/projections) authored on the standalone `@xgis/shader-dsl` framework package (the IR + backends + emit live in that package now, not under `engine/`). `index.ts` is the only public barrel — consumers import `from '../shaders/dsl'`, never the inner modules. | `@xgis/shader-dsl` (framework), `compiler` types; leaf w.r.t. other engine subsystems |
| **text**        | `engine/text/`        | Label pipeline: `text-stage.ts` (resolve → layout → collision → raster → atlas), `text-renderer`, `text-collision`, `sdf/` glyph atlas + PBF/Canvas rasterizers.                                                                                                                                                                                               | `gpu/frame-arena`, `shader-dsl` (text/sdf graphs), `sdf/` internals                   |
| **sprite**      | `engine/sprite/`      | Icon pipeline: `icon-stage.ts`, `icon-renderer.ts`, `sprite-atlas-host/gpu`. Parallel to text but for sprites/POI/shields.                                                                                                                                                                                                                                     | `gpu`, `shader-dsl` (icon graph)                                                      |
| **camera**      | `engine/camera/`      | **Empty.** Camera code lives in `engine/projection/camera.ts` and `engine/camera-controller.ts` (engine root). The `camera/` dir is a placeholder.                                                                                                                                                                                                             | —                                                                                     |

Note on `engine/shaders/dsl/projections.ts` vs the legacy
`engine/shaders/projection.ts`: the DSL `dsl/projections.ts` is the
emit graph; a separate legacy `engine/shaders/projection.ts` still exists
and is consumed in places. Treat `shaders/dsl` as the emit authority going
forward, but both paths are live in the tree today.

---

## 3. `projections-table.ts` — the single source of truth

`engine/projection/projections-table.ts` (196 lines) is the most widely-read
data file in the engine. The `PROJECTIONS` array (line 87) is an **ordered
record array where `index == projType == the `proj_params.x` value the
shaders read** — one row per projection, 0=mercator … 7=globe. Every
projType↔name↔capability fact derives from it.

```
projType:   0          1            2          3       4        5       6        7
name:    mercator  equirect  natural_earth  ortho  azi-eq  stereo  obl-merc  globe
            │          │            │          │      │        │       │        │
            └──────────┴────────────┴──────────┴──────┴────────┴───────┴────────┘
                                         │
          ┌──────────────────────────────┼───────────────────────────────────┐
          ▼                              ▼                                    ▼
  PROJECTION_NAME_TO_TYPE        worldCopiesFor / enumerateWorldCopies   cullThreshold /
  SELECTOR_PROJ_NAMES            routeToSphereSelector                   rimThreshold /
  (name↔int)                    promotesToGlobeWhenTilted               worldBand / isFlat…
                                (derived predicates — "the authority flip")
```

The header (`projections-table.ts:1-21`) records _why_ this exists: the same
projType↔name relation was previously hand-encoded across ~3 representations
(the render-loop name→int map, VTR's `SELECTOR_PROJ_NAMES` int→name array, and
inline collapses in `tiles-sse` / `tile-select`). The table is the canonical
data those sites now derive from. `gpu-shared.ts` **re-exports** the derived
predicates (`gpu-shared.ts:303-309`) so its consumers — `tiles-sse`,
`tile-select`, `vector-tile-renderer`, `camera`, label-pass — are unchanged
while the authority lives in one file.

Two facts the table makes explicit are documented as _latent bugs_ in the
header comments, not hidden:

- **`promotesToGlobeWhenTilted` vs `routeToSphereSelector`** disagree for
  `oblique_mercator` (6): it sphere-routes its tiles but is excluded from
  promotion (it is cylindrical) → flat MVP + sphere tiles at pitch>0. "The
  difference between these two predicates IS the bug, made explicit by the
  table" (`projections-table.ts:135-142`).
- **`flatViewHeightCapM`** caps only ortho (3) at `2·EARTH_R` — the z0 disc
  framing fix — with azi-eq/stereo deferred (`projections-table.ts:161-185`).

---

## 4. God-objects — the known #1 architectural debt

Six classes dominate the engine by size and by method count, and they own
state that should be distributed. This is the **#1 architectural debt**:
unclear state-ownership. A decomposition review exists
(`project_godfile_decomposition_review_2026_05_30.md`; the master plan at
`.omc/plans/master-plan-2026-05-30.md`) but is **unexecuted** — these files
remain monolithic.

| Class                  | File                                 | LOC  | ~Methods | Role                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------ | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VectorTileRenderer** | `render/vector-tile-renderer.ts:110` | 5608 | ~237     | GPU buffers, bind groups, draw calls for vector tiles. Header asserts "GPU buffers, bind groups, and draw calls only" — data/cache/sub-tiling is TileCatalog's — yet it is by far the largest file.                                                                                               |
| **XGISMap**            | `map.ts:96`                          | 2956 | ~204     | The wiring hub / public API entry. Owns renderers, stages, camera, controllers, TileCatalog, SourceManager. `renderFrame` was relocated verbatim into `render-loop.ts` but still reaches ~30 private map fields via a typed `host` view (relocation, not decoupling — see `render-loop.ts:1-15`). |
| **TextStage**          | `text/text-stage.ts:601`             | 1967 | ~66      | Label pipeline: resolve → layout → collision → raster → atlas. 0 dedicated unit tests historically (per architecture audit).                                                                                                                                                                      |
| **MapRenderer**        | `render/renderer.ts:203`             | 1947 | ~82      | Non-tile WebGPU renderer (graticule, polygon/line shader pipelines, compute layer registry, OIT compositing).                                                                                                                                                                                     |
| **TileCatalog**        | `data/tile-catalog.ts`               | 1388 | ~109     | Tile router + cache + sub-tile clipping. Routes (z,x,y) to TileSource backends (XGVT-binary, PMTiles, GeoJSON-runtime); manages cache/eviction/budget/fan-out. CPU-only — GPU upload is VTR's job.                                                                                                |
| **Camera**             | `projection/camera.ts:13`            | 1210 | ~41      | View/projection matrix construction for all 7 surfaces + globe; flat-vs-ECEF MVP gate.                                                                                                                                                                                                            |

Method counts are approximate (a grep over indented method-like
declarations, including overloads/getters); LOC are exact `wc -l`.

### Why this is the root debt

- **State-ownership is unclear.** XGISMap owns most engine objects but
  delegates per-frame work to RenderLoop through a `host` back-reference,
  so the render path reads dozens of map privates — the boundary is
  syntactic, not architectural (`render-loop.ts:3-12`).
- **VTR's own header** narrows its job to "GPU buffers, bind groups, and
  draw calls only" (`vector-tile-renderer.ts:2-4`) — the 5608-line reality
  is the gap between the intended contract and the accreted state.
- The decomposition review identifies the recurring roots: god-object
  state-ownership, flat-switch duplication, and copied math kernels, with a
  proposed `≤500`-line ratchet and shared-module extraction (`ecef`,
  projection-policy registry, emit factories, uniform-pack). The
  `projections-table.ts` authority flip and the `@xgis/shared` ecef
  re-export are the _executed slices_ of that direction; the god-file splits
  themselves are not done.

---

## 5. Quick reference — "where does X live?"

| Concern                                   | Module                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Projection capability / projType          | `projection/projections-table.ts` (SoT)                                                          |
| Camera / view matrix / globe              | `projection/camera.ts`, `projection/globe.ts`                                                    |
| WGSL emit                                 | graphs in `engine/shaders/dsl/` (barrel `shaders/dsl/index.ts`), framework in `@xgis/shader-dsl` |
| Vector tile draw                          | `render/vector-tile-renderer.ts`                                                                 |
| Non-tile draw (graticule, OIT, pipelines) | `render/renderer.ts` (MapRenderer)                                                               |
| Per-frame orchestration                   | `render-loop.ts` (delegate of XGISMap)                                                           |
| Tile routing / cache                      | `data/tile-catalog.ts`                                                                           |
| GPU device / arenas / `WORLD_MERC`        | `gpu/gpu-shared.ts`, `gpu/gpu-arena.ts`                                                          |
| Labels                                    | `text/text-stage.ts`                                                                             |
| Icons / sprites                           | `sprite/icon-stage.ts`                                                                           |
| ECEF / WGS84 math (shared kernel)         | `@xgis/shared/ecef.ts`                                                                           |
| Public API entry                          | `map.ts` (XGISMap)                                                                               |
