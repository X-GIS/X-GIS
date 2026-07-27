# `@xgis/engine`

The content-blind, backend-neutral GPU core of X-GIS. It re-exports the RHI
(render-hardware-interface) that renderers target instead of a raw `GPUDevice`, and owns
the small set of primitives that are true of ANY renderer: GPU + CPU allocators, the
reflection-derived uniform packer, the descriptor-driven draw backbone, and the neutral
render context. It knows nothing about map _content_ — no layers, styles, tiles, or
projections — and that is **compiler-enforced**: `tsconfig.json` sets `"types": []`, so a
native `GPU*` identifier anywhere in `engine/src` is a build error.

> `private: true` — workspace-internal, not published to npm. Consumers are `@xgis/map`,
> `@xgis/data`, `@xgis/rhi-webgpu` (type-level, baselined), and the playground/site
> builds. `@xgis/runtime` reaches the engine only transitively, through `@xgis/map`.

## What is actually here

`engine/src` is **10 source files**. This package is deliberately small and is being grown
by EPIC #991, which promotes the content-blind GPU primitives still trapped in
`map/src/render/**` into it, one phase at a time.

| Module                                | Responsibility                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | The barrel — also re-exports all of `@xgis/rhi`, so a consumer imports RHI types from here.                                                    |
| `src/gpu/gpu-arena.ts`                | `GPUArena` — single shared buffer, linear alloc, relocation/compaction (the `drawIndexedIndirect` precondition).                               |
| `src/gpu/quality.ts`                  | `QUALITY` presets + the `?quality=` / `?msaa=` / `?dpr=` URL knobs, DPR caps, safe/pick mode flags.                                            |
| `src/render/uniform-block.ts`         | `UniformBlock.of(struct)` — typed std140 packing derived from `@xgis/shader-dsl`'s `reflect()`, so the DSL struct is the one layout authority. |
| `src/render/frame-arena.ts`           | `FrameArena` — pure-CPU per-frame bump allocator (no GPU coupling).                                                                            |
| `src/render/uniform-ring.ts`          | `UniformRing` — growable per-draw uniform ring over one buffer + a CPU staging mirror (#991 P2).                                               |
| `src/render/material.ts`              | `Material` / `executeItems` + the `MaterialDesc` / `PipelineVariant` / `DrawItem` descriptor triad — the generic draw backbone (#991 P1).      |
| `src/render/render-context.ts`        | `RenderContext` / `RhiDeviceLostInfo` / `BackendChoice` — the neutral boot + per-frame context a backend context extends.                      |
| `src/shaders/log-depth.ts`            | CPU-side logarithmic-depth helpers (the twin of the WGSL side).                                                                                |
| `src/shaders/dsl/overdraw-compose.ts` | The DSL-authored overdraw-compose module — a content-blind full-screen leaf.                                                                   |

## What is deliberately NOT here

- **Projections / camera / ECEF.** The ellipsoid math is `@xgis/shared`, the projection
  library is `@xgis/geo`, and the map camera is `@xgis/map` (#781 3c/3d). The engine does
  not carry even the projection vocabulary.
- **The frame-uniform schema.** Its `proj_params` / meters-per-pixel lanes are map
  content; `@xgis/map` declares the struct and packs it through the engine's generic
  `UniformBlock` (#991 P0).
- **Anything WebGPU-typed.** The device init, swapchain, `GPUTimer`, `RenderTargets`,
  staging pool, bundle cache and compute dispatch live in `@xgis/rhi-webgpu`; the WebGL2
  backend in `@xgis/rhi-webgl2`. (That several of those are engine-layer concerns sitting
  in a backend adapter is known, and is what the `['rhi-webgpu','engine']` baseline in
  `dependency-direction-ratchet.test.ts` tracks.)

## Install / build

```bash
bun install
bun run build   # tsc --build → dist/ + .d.ts
```

Consumers resolve `@xgis/engine` through each package's `paths` mapping to
`dist/index.d.ts` (`data/`, `map/`) or through the site/playground Vite source aliases.
Root `bun run build` orders it after `@xgis/shared` → `@xgis/shader-dsl` → `@xgis/rhi`.

## Verified

- **Unit gate** — colocated `*.test.ts` run by the root Vitest (CI leg `engine-rhi-data`):
  arena alloc/relocation/grow, frame arena, `UniformBlock` std140 packing, `UniformRing`
  grow/flush, log-depth math.
- **Boundary gate** — `src/dependency-direction-ratchet.test.ts` pins the whole monorepo's
  allowed package-dependency graph and fails CI on any new cross-package edge.
- **Render gate** — real-GPU behaviour is covered by the Playwright e2e suites in
  `playground/`, which drive `@xgis/map` on top of this engine.
