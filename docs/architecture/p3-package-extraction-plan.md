# P3 Execution Plan — @xgis/engine + @xgis/map extraction

> Synthesized 2026-07-01 from a 5-scout read-only recon (engine-machinery set, content set,
> render-loop/map.ts boundary, package/build/vite wiring, cross-imports + Gate-6), after P2
> Steps 1-4 made the engine machinery content-blind IN-PLACE. P3 physically extracts the
> packages. Authority peer: [p2-engine-carve-plan.md](./p2-engine-carve-plan.md).

## 0. The key decision (render-loop cut) — SETTLED

The "FrameRendererHost-in-engine" inversion (keep `render-loop.ts` in engine, feed it a host
interface) is **REJECTED**. The host-read table proves `render-loop.ts` reads `iconStage`,
`textStage`, `vtSources`, `showCommands`, `_backgroundColor*`, `_light`, `_rasterShow` EVERY
frame. Any host interface typing those honestly must name content classes → forces
`@xgis/engine` to import `@xgis/map` types (the exact reverse edge Gate-6 forbids); erasing
them to `unknown` destroys type safety.

**Clean cut: `render-loop.ts` is a CONTENT frame-driver → moves to `@xgis/map`** (pure
relocation, no inversion). The content-blind engine half already exists as `frame-renderer.ts`
(P2). `@xgis/engine` exposes `FrameRenderer`, `RenderNode`, `Camera`, `RenderTargets`,
`GPUContext`, `GPUTimer`; `@xgis/map`'s `render-loop.ts` drives them, reading its own
same-package content stages. Result: **0 engine→map edges, full type safety, no gymnastics.**

## 1. File → package assignment

Rule: the grep-verified engine-machinery set (content-blind, import-grep clean) = **engine**;
a file in both lists resolves to engine if its imports are content-clean.

### @xgis/engine (content-blind machinery, ~47 files)

- **RHI**: `render/rhi/{rhi,rhi-webgpu,rhi-webgl2}.ts`
- **GPU**: `gpu/{gpu,gpu-arena,gpu-shared,gpu-timer,compute,compute-webgl2,frame-arena,frame-uniform,staging-buffer-pool,palette-texture,quality,bind-tiers}.ts`
- **Projection/camera (pure math)**: `projection/{camera,camera-helpers,camera-world-copies,view-matrix,projection,projections-table,unproject,ecef,globe,globe-anchor,earth-surface-fill}.ts`
- **Frame/render core**: `render/{frame-context,projection-token,render-targets,scene-view,render-node,frame-draw-stats,frame-renderer}.ts`
- **Pipeline/bind/upload machinery**: `render/{pipeline-factory,compose-pipelines,reflection-to-webgpu,vertex-buffer-layout,bind-group-registry,uniform-ring,bundle-cache,compute-bind-layout,compute-layer-registry,upload-coordinator,tile-selection-cache}.ts`
- **Shader DSL**: `shaders/dsl/{consts,index}.ts`

### @xgis/map (content)

renderer.ts/renderer-types.ts/renderer-helpers.ts · passes/** (11) · VTR cluster
(vector-tile-renderer*, bucket-scheduler, gpu-tile-store, tile-compute-resources,
feature-data-binder, compute-feature-packer, prefetch-scheduler) · material/** (9) · text/** ·
sprite/** · {line,point,heatmap,raster,graticule}-renderer.ts + graticule.ts · paint-eval
(paint-shape-resolve, resolved-show, line-pattern, label-feature-source) · content layouts
({point,line,text,icon}-vertex-format, {line,polygon,raster,heatmap}-uniform-slots,
globe-eye-uniform) · **frame driver render-loop.ts** · **public facade map.ts (XGISMap)**.

### shell (runtime → thin barrel)

`runtime/src/index.ts` re-exports `@xgis/map` + `@xgis/engine` public API; `runtime/src/web/component.ts`
imports `XGISMap` from `@xgis/map` (the ONE allowed map→engine-direction value edge).

### Judgment-call files (grep at move time; engine only if content-clean, else map)

`bind-group-registry.ts`, `upload-coordinator.ts`, `tile-selection-cache.ts`;
`globe-eye-uniform.ts` → **map** (content paths write it).

## 2. Package/build/vite wiring (sibling-package model, real-GPU preserving)

- `engine|map/package.json`: `type:module`, main/module/types→`dist/`, `build: vite build && bun scripts/build-dts.ts`. Deps: engine→`@xgis/{compiler,shader-dsl,shared}`; map→`@xgis/{engine,compiler,shader-dsl,shared}`.
- `engine|map/tsconfig.json`: `extends ../tsconfig.base.json`, `composite:true`, `outDir:dist`, `rootDir:src`, `types:["@webgpu/types"]`, `paths`→sibling `dist/*.d.ts`, `references`. **Build order: shader-dsl → compiler/shared → engine → map** (avoids TS6305/TS6059).
- Root `package.json` workspaces: add `engine`, `map`.
- `playground/vite.config.ts`: alias `@xgis/engine`→`../engine/src/index.ts`, `@xgis/map`→`../map/src/index.ts` (SOURCE aliasing keeps real-GPU dev/test on src, not dist — critical for DC=0); add both to `optimizeDeps.exclude`.

## 3. Ordered move (tsc --build + full suite + DC=0 green at EACH step)

**DC=0 oracle**: capture a multi-style baseline (merc + globe + label/heavy-VTR) first. A pure
source relocation must not move a pixel → DC must equal 0 after each step. DC>0 = the move
changed module-init order (eager-reflect / projections-table) = a real bug, stop + fix.

- **Step 0 — Baseline.** DC baseline frames; `tsc --build` + suite green.
- **Step 1 — Scaffold empty packages.** engine/ + map/ with package.json/tsconfig/`src/index.ts`
  (`export {}`); root workspaces; vite aliases + excludes; references; `bun install`. Structural
  (no pixels) but the ONLY step adding the build graph — wrong tsconfig reference order breaks
  everything. Verify tsc --build green; DC=0; suite.
- **Step 2 — Engine leaf: RHI + GPU** → `engine/src/{render/rhi,gpu}`; rewrite importers to `@xgis/engine`. tsc; DC=0; suite.
- **Step 3 — Projection/camera (pure math)** → `engine/src/projection`. ⚠ projections-table init must NOT move earlier than `configureProjections`. DC=0 (globe+merc; 16-split if DC≠0).
- **Step 4 — Frame/render core machinery** → `engine/src/render`. tsc; DC=0; suite.
- **Step 5 — Pipeline/bind/upload/compute + FINISH engine.** First grep the 3 judgment-call files; demote any unclean to map. ⚠ uniform-ring grow + any `reflect()` must stay lazy (#612 eager-reflect crash). Verify tsc; DC=0; suite; **real-GPU map-load** (SwiftShader misses this); run `no-eager-uniform-reflect.test` + architecture-invariants engine shard. Invariant: @xgis/engine COMPLETE + content-blind.
- **Step 6 — Map leaf content (bottom-up):** vertex/uniform-formats → materials → geometry renderers → sprite → text → VTR → passes → renderer.ts (all import `@xgis/engine`). ⚠ `*-uniform-slots` `reflect()` lazy-only. Verify each sub-step tsc; DC=0; **real-GPU map-load after each material move**.
- **Step 7 — THE CUT: render-loop.ts → map** (pure relocation; delete `import type XGISMap`; reads same XGISMap fields same-package; calls `@xgis/engine` FrameRenderer/Camera/RenderTargets). Do NOT change the host-access pattern. DC=0 full multi-style sweep (16-split). Invariant: frame driver in content; engine has no frame-driver type referencing content.
- **Step 8 — map.ts + shell barrel.** `map.ts`→`map/src/map.ts`; `web/component.ts` stays in shell importing `@xgis/map`; `runtime/src/index.ts` re-exports both. tsc; DC=0; suite; real-GPU playground load.
- **Step 9 — Gate-6 + lock.** architecture-invariants: zero `@xgis/map` imports in any `engine/**` file (incl `import type`) + companion (no engine deep-import of map). Passes immediately (0 reverse edges). Full architecture-invariants both shards green.

## Steps that CANNOT be pure source-relocation (flagged)

1. **Step 1** scaffold — structural; wrong tsconfig reference order breaks downstream.
2. **Steps 3 & 5 & 6** — pure ONLY if module-init order preserved (projections-table init,
   uniform-ring grow, `*-uniform-slots` lazy `reflect()` — the #612/#193 hazards). Each must be
   DC=0 + **real-GPU map-load** verified, NOT just tsc/SwiftShader.
3. **Step 7 render-loop** — pure ONLY because we chose relocation over the FrameRendererHost
   inversion (the inversion = a behavior-touching refactor + Gate-6 violation).
   Steps 2,4,8 = mechanical relocation + atomic import-path rewrite, gated by DC=0.
