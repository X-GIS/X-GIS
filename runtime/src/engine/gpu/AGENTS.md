<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# gpu

## Purpose

Low-level WebGPU infrastructure shared by all renderers in the X-GIS engine. This directory owns device initialisation and lifecycle (`gpu.ts`), all shared pipeline-state constants (blend modes, stencil/depth states, MSAA — `gpu-shared.ts`), quality/DPR/MSAA configuration (`quality.ts`), the linear GPU-buffer arena allocator used for shared vertex/index storage (`gpu-arena.ts`), a CPU-side per-frame bump allocator for transient typed-array scratch (`frame-arena.ts`), a tiered async staging-buffer pool for tile upload (`staging-buffer-pool.ts`), the shared per-frame uniform buffer layout (`frame-uniform.ts`), a 4-tier bind-group descriptor planner (`bind-tiers.ts`), GPU timestamp-query profiling (`gpu-timer.ts`), compile-time palette packing and GPU texture upload for colour/scalar/gradient atlases (`palette-texture.ts`), and a compute-shader dispatcher for per-feature expression evaluation (`compute.ts`).

## Key Files

| File                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gpu.ts`                 | WebGPU device init (`initGPU`, `resizeCanvas`), `GPUContext` bundle (device, format, canvas, feature flags including `float32FilterableSupported`, `timestampQuerySupported`, `timestampInsidePassesSupported`, `deviceLost`, `onDeviceLost`), `WebGPUUnavailableError` for graceful degradation, device-loss guard, validation-error queue (`getValidationErrors`, `clearValidationErrors`) for test assertions, `SAFE_MODE` / `GPU_PROF` URL flags, runtime quality accessors (`getSampleCount`, `getMaxDpr`, `isPickEnabled`). |
| `gpu-shared.ts`          | Canonical `GPUBlendState` / `GPUDepthStencilState` / `GPUMultisampleState` constants (`BLEND_ALPHA`, `BLEND_ALPHA_PREMULT`, `BLEND_MAX`, `BLEND_OIT_ACCUM`, `BLEND_OIT_REVEALAGE`, `OIT_ACCUM_FORMAT`, all `STENCIL_*` and `DEPTH_*` variants, per-tile clip-mask states, `MSAA_STATE`). Also `WORLD_MERC`, `TILE_PX`, and re-exports of world-copy helpers from `projections-table`.                                                                                                                                             |
| `quality.ts`             | `QualityConfig` + `QUALITY_PRESETS` (default / performance / balanced / battery), URL-flag resolver (`?quality`, `?msaa`, `?dpr`, `?adaptiveDpr`, `?picking`, `?debug=overdraw`), mutable `QUALITY` singleton, `updateQuality` + `onQualityChange` listener API. Adaptive MSAA auto-disabled at DPR ≥ 2.                                                                                                                                                                                                                          |
| `gpu-arena.ts`           | `GPUArena`: linear bump-pointer + exact-align4 free-list allocator over a single `GPUBuffer`. Provides `alloc`, `free`, `canServe`, `reclaimIfDrained`, `getStats`. Byte-aware eviction with 75/60 hysteresis + alloc-fail safety net (PR #193 fix for globe z10-11 OOM crash). OOM diagnostic enumerates live/free/bump stats on throw.                                                                                                                                                                                          |
| `frame-arena.ts`         | `FrameArena`: CPU-side bump allocator over a single `ArrayBuffer`, reset each `beginFrame()`. Typed allocation helpers `allocF32`, `allocU32`, `allocI32`, `allocF64`. Grows 1.5× when peak watermark exceeds 90% of capacity. Eliminates per-frame `new Float32Array(N)` churn in the label/projection pipelines.                                                                                                                                                                                                                |
| `staging-buffer-pool.ts` | `StagingBufferPool`: tiered pool (7 tiers 4 KB – 16 MB) of `MAP_WRITE                                                                                                                                                                                                                                                                                                                                                                                                                                                             | COPY_SRC`staging buffers for async tile upload.`asyncWriteBuffer`helper encodes`copyBufferToBuffer`into the caller's encoder. Falls back to`queue.writeBuffer`on SwiftShader / headless CI where`mappedAtCreation` fails. |
| `frame-uniform.ts`       | `FrameUniform`: 128-byte shared GPU uniform buffer (`mvp`, `proj_params`, `viewport`, `_pad`). `setFrame()` writes once per frame keyed by `frameTag` (idempotent). Currently dormant in production (each renderer owns its own uniforms) but actively exercises `Camera.getFrameView` in tests. Exports `WGSL_FRAME_UNIFORM` WGSL snippet.                                                                                                                                                                                       |
| `bind-tiers.ts`          | `planTierLayout` pure descriptor planner for the 4-tier bind-group hierarchy (Constants 0 / Camera 1 / Tile 2 / Feature 3). `BindTierRegistry` caches `GPUBindGroupLayout` handles per tier. Validates for intra-tier `@binding` collisions at plan time.                                                                                                                                                                                                                                                                         |
| `gpu-timer.ts`           | `GPUTimer`: timestamp-query profiling behind `?gpuprof=1`. 3-slot readback ring; supports Chromium `timestamp-query-inside-passes` for sub-pass breakdown (bg / raster / legacy / vt / compute). `passWrites()` / `computeWrites()` / `mark()` / `resolveOnEncoder()` / `pollReadbacks()` / `getBreakdown()`.                                                                                                                                                                                                                     |
| `palette-texture.ts`     | `packPalette` (pure) + `uploadPalette` / `destroyPalette` (GPU). Produces four textures from a compiler `Palette`: `rgba8unorm` colour atlas, `r32float` scalar atlas, `rgba16float` colour-gradient atlas, `r32float` scalar-gradient atlas. Pre-bakes zoom-stop ramps to 256-texel rows via Mapbox exponential curve formula.                                                                                                                                                                                                   |
| `compute.ts`             | `ComputeDispatcher`: caches `GPUComputePipeline` by `(wgsl, entryPoint)`, dispatches compiler `ComputeKernel` objects (3-binding layout: `feat_data`, `out_color`, `u_count`). Buffer factories (`createFeatDataBuffer`, `createOutColorBuffer`, `createCountBuffer`). Legacy 2-binding `dispatch()` preserved for back-compat.                                                                                                                                                                                                   |

## For AI Agents

### Working In This Directory

- `QUALITY` is a mutable singleton read at pipeline-creation time. Changes to `msaa` or `picking` require renderer `rebuildForQuality()` calls — never mutate `QUALITY` directly outside `updateQuality`. The deprecated `SAMPLE_COUNT` / `MAX_DPR` / `PICK` module-load snapshots exist only for back-compat; all new code must use the getter functions `getSampleCount()` / `getMaxDpr()` / `isPickEnabled()`.
- `MSAA_STATE` in `gpu-shared.ts` snapshots `SAMPLE_COUNT` at module load. Pipeline creation sees the initial value; runtime MSAA changes only take effect after renderer rebuild.
- Blend and stencil constants in `gpu-shared.ts` are the single source of truth — do not redefine them inline in renderers. A new blend mode or stencil variant belongs here.
- `GPUArena.free(offset, bytes)` requires the SAME `bytes` as the original `alloc`. Mismatches silently fragment the free-list (exact-align4 key goes to the wrong bucket) but cannot corrupt memory. Tests pin alloc/free symmetry.
- `FrameArena` sub-views become stale across `beginFrame()`. Never retain typed-array refs from a prior frame. Mid-frame grows orphan earlier views from that same frame — no current call site retains a view past an alloc, but this invariant must hold.
- `StagingBufferPool` falls back to `queue.writeBuffer` on SwiftShader (headless CI). The `hasMappedAtCreationFallback` flag flips on first failure; `asyncWriteBuffer` detects it automatically. Do not bypass this fallback path in new upload code.
- `WebGPUUnavailableError` must be caught specifically by the map layer to fire `onWebGPUUnavailable()`. It is not a generic GPU fault.
- `device.lost` is handled inside `initGPU`; the `'destroyed'` reason is intentional teardown and is intentionally NOT forwarded to `onDeviceLost`.

### Testing Requirements

Test files in this directory: `gpu-arena.test.ts`, `frame-arena.test.ts`, `staging-buffer-pool.test.ts`, `bind-tiers.test.ts`, `palette-texture.test.ts`, `frame-uniform.test.ts`, `compute.test.ts`, `webgpu-unavailable.test.ts`, `world-copy-gap.test.ts`. All run under `vitest` without a real GPU — tests stub or skip device-dependent paths. GPU-dependent behaviour (pipeline compile, actual draw) is exercised by the CI SwiftShader path in `engine/render/`. Changes to arena eviction logic should be validated against the OOM scenario documented in project memory (`project_gpuarena_oom_byte_aware_eviction_2026_05_31.md`).

### Common Patterns

- Pure CPU functions (`packPalette`, `planTierLayout`, gradient evaluation) are split from their impure GPU counterparts (`uploadPalette`, `BindTierRegistry`) so they remain unit-testable without a device stub.
- Every `device.createBuffer` / `createTexture` call passes a `label` string for WebGPU DevTools attribution.
- Empty-pool stubs use `Math.max(count, 1)` to keep bind-group construction unconditional — no `if (count > 0)` branching at consumer sites.
- URL flags (`?safe=1`, `?gpuprof=1`, `?quality=`, `?msaa=`, `?dpr=`, `?adaptiveDpr=`, `?picking=1`) are read once at module load and drive the mutable singletons `SAFE_MODE`, `GPU_PROF`, and `QUALITY`.

## Dependencies

### Internal

- `../projection/projections-table` — `WORLD_COPIES`, `worldCopiesFor`, `enumerateWorldCopies`, `routeToSphereSelector` (re-exported from `gpu-shared.ts`)
- `../projection/camera` — `Camera` type consumed by `FrameUniform.setFrame`
- `../shaders/dsl/frame-uniform` — `emitFrameUniformWgsl()` used by `frame-uniform.ts`

### External

- `@xgis/compiler` — `ComputeKernel`, `Palette`, `ColorGradient`, `ScalarGradient` types consumed by `compute.ts` and `palette-texture.ts`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
