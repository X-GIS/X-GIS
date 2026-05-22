<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# gpu

## Purpose
The WebGPU device/context layer and the cross-renderer GPU resource managers. `gpu.ts` initialises the device, canvas, sample count, DPR clamp, and mobile detection. `gpu-shared.ts` is the single home for blend/stencil/depth state, world-Mercator + tile-pixel constants, and `worldCopiesFor` — extracted to stop configuration drift across renderers. The rest are shared services: a per-frame uniform buffer (one source of MVP/projection/viewport for every renderer), CPU and GPU bump/arena allocators, a tiered staging-buffer pool for async tile upload, palette storage textures, the compute dispatcher for per-feature expression evaluation, and GPU timestamp timing.

## Key Files
| File | Description |
|------|-------------|
| `gpu.ts` | WebGPU context init (`initGPU`, `resizeCanvas`), `isMobile` (drops MSAA + clamps DPR on phones), `getSampleCount`, `getMaxDpr`, `isPickEnabled`. |
| `gpu-shared.ts` | Shared blend/stencil/depth states, `WORLD_MERC`, `TILE_PX`, OIT formats, `worldCopiesFor`. Prevents per-renderer config drift. |
| `frame-uniform.ts` | One shared per-frame uniform buffer (MVP, projType/center, viewport, m/px, log-depth FC) — replaces each renderer keeping its own duplicate buffer (which caused double-write-offset-0 bugs). |
| `compute.ts` | `ComputeDispatcher` — runs compute shaders for per-feature expression evaluation (feature props in → computed colors/sizes out). |
| `frame-arena.ts` | CPU-side linear bump allocator (single ArrayBuffer, watermark, reset per `beginFrame`) for transient per-frame scratch (shaping, layout, sort keys). |
| `gpu-arena.ts` | GPU-side linear arena over one buffer — replaces per-tile acquire/release pooling; precondition for `drawIndexedIndirect`. |
| `staging-buffer-pool.ts` | Tiered `MAP_WRITE\|COPY_SRC` staging buffers for async tile upload (`borrow`→fill→`copyBufferToBuffer`→`release`; `mapAsync` natively waits on the copy). |
| `bind-tiers.ts` | 4-tier bind-group descriptor planner — un-collapses the single over-coupled `@group(0)` into stable tiers. |
| `palette-texture.ts` | Compile-time `Palette` → GPU storage textures (color/width/etc. rows). `packPalette`/`uploadPalette`. |
| `quality.ts` | `QUALITY` per-deployment fidelity/budget knobs (URL flags + presets); defaults preserve current behavior. |
| `gpu-timer.ts` | WebGPU timestamp-query timing — mid-pass markers (bg/raster/legacy/vt) within sub-pass 0 plus whole-pass timing. |

## For AI Agents

### Working In This Directory
- Put any constant or pipeline-state used by 2+ renderers in `gpu-shared.ts` — drift across renderer copies has been a real source of bugs.
- Use the shared `frame-uniform.ts` buffer; do not reintroduce per-renderer uniform buffers (double writeBuffer to offset 0 in one frame corrupts state — the documented motivation for unification).
- The uniform ring (mid-frame grow) is delicate: a known fixed bug left pre-grow draws pointing at the OLD buffer (stale colours at high pitch). On any ring/buffer-grow change, re-run the uniform-ring tests in `render/`.
- Mobile path drops MSAA + clamps DPR by design — don't add visual-tradeoff DPR/MSAA knobs as the fix for slowness; attack scene complexity instead.

### Testing Requirements
- `frame-uniform.test.ts`, `frame-arena.test.ts`, `gpu-arena.test.ts`, `staging-buffer-pool.test.ts`, `bind-tiers.test.ts`, `palette-texture.test.ts`, `compute.test.ts`, `world-copy-gap.test.ts`. GPU-touching tests use the `__test-support__/webgpu-stub`.

### Common Patterns
- Arena/bump allocation reset per frame. Shared single-source-of-truth buffers + constants. Tiered staging with `mapAsync` back-pressure.

## Dependencies

### Internal
- `engine/shaders` (log-depth FC), `@xgis/compiler` (`Palette`, `ComputeKernel`).

### External
- `@webgpu/types`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
