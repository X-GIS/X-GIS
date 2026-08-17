# Module dependency map

Last revised: 2026-07-27 (§1 rewritten for the `@xgis/runtime` dissolution; the
former §2–§5, which described the pre-split `runtime/src/engine/` tree, were
pruned the same day — §2 below re-grounds the one part worth keeping, the
"where does X live" quick reference, to the current tree).

This document maps the import-direction DAG of X-GIS. §1 is authoritative and
mechanically enforced.

It is a **map**, not a tutorial. Every edge below is an actual `import`
direction in the source — verified, not aspirational. When the code moves,
this file is wrong; treat a divergence as a doc bug.

---

## 1. Package DAG

Fourteen workspaces. The graph is **not** documentation-by-convention: it is
pinned, edge by edge, in `engine/src/dependency-direction-ratchet.test.ts`,
which fails CI on any new cross-package `src` import outside the allowed set.
Read that file's `ALLOWED` map as the source of truth; the table below is its
prose rendering. The arrow is the import direction (`A → B` = "A imports B").

| Package              | May import                    | Role                                                                                                   |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@xgis/shared`       | — (leaf)                      | WGS84/ECEF math, quantization, logging — the kernel both sides must agree on.                          |
| `@xgis/shader-dsl`   | — (leaf)                      | Content-free shader IR + WGSL/GLSL/CPU-f64 emit.                                                       |
| `@xgis/rhi`          | — (leaf)                      | The render-hardware interface: `Rhi*` handles, vertex/compute contracts.                               |
| `@xgis/geo`          | `shared`                      | The projection library (projections-table, globe, world scale).                                        |
| `@xgis/compiler`     | `shader-dsl`, `shared`, `rhi` | `.xgis`/Mapbox → IR + SceneCommands + CompiledTile. No GPU, no shader CODE.                            |
| `@xgis/blueprint`    | `compiler`                    | Visual node-graph authoring; no GPU.                                                                   |
| `@xgis/engine`       | `rhi`, `shader-dsl`, `shared` | Content-blind GPU substrate (arena, uniform packing, draw backbone).                                   |
| `@xgis/rhi-webgpu`   | `rhi`, `shader-dsl`           | WebGPU backend + device/swapchain/timer/targets.                                                       |
| `@xgis/rhi-webgl2`   | `rhi`, `shader-dsl`           | WebGL2 fallback backend.                                                                               |
| `@xgis/data`         | `shared`, `geo`, `compiler`   | Tile catalog/sources/loaders, worker pools, polar caps.                                                |
| `@xgis/map`          | every library layer above     | The composition root AND the one published package: renderers, camera, text/sprite stages, the facade. |
| `@xgis/pipeline`     | — (leaf)                      | Offline data-prep utilities.                                                                           |
| `playground`, `site` | consumers                     | Dev app + docs site; import `@xgis/map` (and `@xgis/compiler`/`blueprint`).                            |

```
        shared ── geo ─┐         shader-dsl        rhi
          │            │             │              │
          └──▶ compiler ◀────────────┘              │
                  │                                 │
                  ▼                     engine ◀────┤
                 data                      ▲        │
                  │                        │   rhi-webgpu / rhi-webgl2
                  └──────────▶  map  ◀─────┴────────┘
                                 │
                    playground / site (consumers)
```

Grounded notes:

- **No cycles, enforced.** The `blueprint` editor imports only `compiler`; the
  backends implement `rhi` and may not reach up into `engine`; `engine` may not
  import `map` or `geo` (Gates 6 and 7 in
  `map/src/architecture-invariants.test.ts`).
- **`@xgis/runtime` no longer exists** (dissolved 2026-07-27). It had shrunk to a
  re-export barrel plus a large test corpus belonging to other packages; the
  capability table and the `<xgis-map>` element moved to `@xgis/map`, which took
  over publication (`map/src/public.ts`).
- **`@xgis/shared` is the shared math kernel.** It is imported by both the
  renderer's ECEF module and `compiler/src/tiler/vector-tiler.ts`, specifically so
  the tiler and the renderer share one ECEF source instead of hand-mirroring
  constants across the package barrier.

---

## 2. Quick reference — "where does X live?" (current tree)

The historical subsystem map and god-object table that used to live here
described `runtime/src/engine/**` and were pruned when that tree dissolved.
Their living successors: file-size debt is enforced by
`map/src/loc-ceiling-ratchet.test.ts` (the one LOC authority), and the
engine/map rebalance analysis lives in `engine-map-rebalance-program.md`.

| Concern                           | Module                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Projection capability / projType  | `geo/src/projections-table.ts` (SoT — the projType-confinement ratchet allows dispatch only here)                         |
| Camera / view matrix / globe      | `map/src/camera/` (`camera.ts`, `view-matrix.ts`, `globe-anchor.ts`) — relocated from the engine by #781 3b               |
| WGSL emit                         | graphs in `map/src/shaders/dsl/` (barrel `index.ts`); framework in `@xgis/shader-dsl`                                     |
| Vector tile draw                  | `map/src/render/vector-tile-renderer.ts`                                                                                  |
| Non-tile draw                     | `map/src/render/renderer.ts` (content half) + `map/src/render/frame-renderer.ts` (engine half)                            |
| Per-frame orchestration           | `map/src/render-loop.ts` (delegate of XGISMap); pass chain registered via `map/src/render/passes/pass-chain.ts`           |
| Tile routing / cache              | `data/src/tile-catalog.ts`                                                                                                |
| GPU memory / arenas               | `engine/src/gpu/gpu-arena.ts`, `engine/src/render/frame-arena.ts`; resident tile store `map/src/render/gpu-tile-store.ts` |
| Uniform packing                   | `engine/src/render/uniform-block.ts` (mechanism) + `map/src/render/frame-uniform.ts` (schema, #991 P0)                    |
| Draw backbone                     | `engine/src/render/material.ts` (`Material` / `executeItems`, #991 P1)                                                    |
| Labels                            | `map/src/text/text-stage.ts`                                                                                              |
| Icons / sprites                   | `map/src/sprite/icon-stage.ts`                                                                                            |
| ECEF / WGS84 math (shared kernel) | `@xgis/shared` (`ecef`, `body`)                                                                                           |
| Public API entry                  | `map/src/map.ts` (XGISMap); published surface `map/src/public.ts`                                                         |
