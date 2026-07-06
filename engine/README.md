# `@xgis/engine`

The content-blind GPU core of X-GIS: the RHI (render-hardware-interface) that renderers
target instead of raw `GPUDevice`, the GPU resource machinery (arena allocator, staging
pools, compute dispatch, timers), and the projection/camera math authority (Web Mercator
through true 3D globe, ECEF, view matrices, unprojection). It knows nothing about map
_content_ — no layers, no styles, no tiles — by construction: even the projection state
crosses the frame boundary as an opaque token the engine cannot decode.

This package is the backend half of the **embeddable-engine split** (`@xgis/engine` +
`@xgis/map`) on the roadmap. The physical carve out of `@xgis/runtime` is real and this
package builds and ships symbols today, but the split is **in progress — an engineering
plan, not a finished public boundary** (see `site/src/pages/docs/concepts/rendering.astro`).

> `private: true` — workspace-internal; this package is **not** published to npm.
> Consumers today are `@xgis/runtime` (which re-exports `Camera`, the projections, and
> `ComputeDispatcher`), `@xgis/map`, and `@xgis/data`.

## Capability taxonomy (honest)

| Capability                                                                                                         | Standing                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **RHI** (`RhiDevice` / `RhiRenderPass` / … — renderers never touch `GPUDevice` directly)                           | **STRONG** — WebGPU impl is the reference path                                                                                    |
| **WebGL2 RHI backend**                                                                                             | real, parity-tested — the fallback proof; MSAA/compute divergences documented in `rhi-webgl2.ts`, unsupported paths fail closed   |
| **GPU arena** (single shared buffer, linear alloc, relocation/compaction — the `drawIndexedIndirect` precondition) | **STRONG**                                                                                                                        |
| **Compute dispatch** (per-feature expression kernels; WebGPU compute + a WebGL2 GPGPU-draw emulation)              | **STRONG**                                                                                                                        |
| **Projection / camera math** (7 flat projections + true 3D globe, ECEF/DSFUN, view-matrix + unproject authority)   | **STRONG** — float-order-preserving extractions from the former runtime Camera                                                    |
| **Reflection-driven pipelines** (`reflection-to-webgpu`, `UniformBlock` typed std140 packing)                      | **DISTINCTIVE** — bind groups + uniform offsets derive from `@xgis/shader-dsl`'s `reflect()`, killing hand-maintained byte tables |
| **Frame machinery** (`FrameContext`, `RenderTargets`, frame arena, staging pools, GPU timers)                      | STRONG — allocation-paranoid per-frame paths                                                                                      |
| **Engine ↔ map public boundary**                                                                                   | **in progress** — the carve is physical, the API contract is not yet frozen                                                       |

## Layout

| Directory         | Responsibility                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/render/rhi/` | The backend-agnostic RHI interface plus its two implementations: `rhi-webgpu.ts` (reference, thin 1:1 wrappers) and `rhi-webgl2.ts` (fallback proof).                                                                                   |
| `src/gpu/`        | Device init (`gpu.ts`, `?safe=1` / `?gl2=1` debug flags), `GPUArena`, `ComputeDispatcher` (+ WebGL2 emulation), frame arena, staging-buffer pool, palette textures, bind tiers, GPU timestamp timers, quality knobs.                    |
| `src/projection/` | `Camera` and its pure extractions (view-matrix, unproject, world copies, flat-anchor helpers), the projections table (`projType ↔ name ↔ capability`), Mercator + alternative projections, true-globe forward/inverse, ECEF re-exports. |
| `src/render/`     | Frame/pipeline machinery: `FrameContext`, `RenderTargets`, `ProjectionToken`, reflection→WebGPU mapping, vertex-buffer layout derivation, render-bundle cache, `UniformBlock`.                                                          |
| `src/shaders/`    | Engine-owned shader math: logarithmic-depth helpers and the DSL-authored overdraw-compose debug pipeline.                                                                                                                               |

Everything public re-exports through `src/index.ts`. One deliberate omission: the dormant
`gpu/frame-uniform` scaffolding is **not** re-exported (no live consumers; its 128-byte
layout predates the current 192-byte per-renderer structs — kept internal so autocomplete
cannot wire a dead path).

## Install / build

A workspace package built with TypeScript project references:

```bash
bun install
bun run build   # tsc --build → dist/ + .d.ts
```

Consumers resolve `@xgis/engine` via each package's `paths` mapping to `dist/index.d.ts`
(`data/`, `map/`) or bundle it through the site/playground Vite aliases. Root
`bun run build` orders it after `@xgis/shared` → `@xgis/shader-dsl` → `@xgis/compiler`.

## Usage

```ts
import {
  Camera,
  getProjection,
  lonLatToECEF,
  GPUArena,
  ComputeDispatcher,
  QUALITY,
  resizeCanvas,
} from '@xgis/engine'
```

WebGPU is the primary target; `initGPU` raises `WebGPUUnavailableError` where WebGPU is
missing, and the WebGL2 RHI exists as the parity-tested fallback path (forced with
`?gl2=1`).

## Verified

- **Unit gate** — 24 colocated `*.test.ts` suites run by the root Vitest (`bun run test`):
  arena alloc/relocation, compute dispatch, camera/projection math (including regression
  suites for real camera bugs), RHI render-pass parity WebGPU↔WebGL2, `UniformBlock`
  std140 packing, log-depth math.
- **Render gate** — real-GPU behaviour is covered by the Playwright e2e suites in
  `playground/` (they exercise the full runtime, which drives this engine).
