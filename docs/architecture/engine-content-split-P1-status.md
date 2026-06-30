# Engine/content split — P1 (all-draws-through-RHI) status + handoff

Companion to `engine-content-split.md` (the P0–P4 design authority) and
`render-graph-pass-scheduler.md`. This file tracks the **P1 implementation** (flip every renderer
to the single RHI Material draw path) and hands off the remaining P1.5/P1.6 + §4-seam + P2–P4 work
with the per-piece scope and the verification methodology learned along the way.

Branch: `feat/engine-content-split`.

## What P1 means + the gate

P1 routes EVERY primitive's draw through the RHI `Material`/`DrawItem`/`executeItems` core so
`@xgis/engine` is backend-agnostic *in fact* — the prerequisite for the P2 carve. Each renderer
increment is gated on a **real-GPU pixel-diff DC=0** (CLAUDE.md §5): render the same scene the raw
way and the RHI-routed way and confirm byte-identical output. Strict `tsc --build` + full suite green.

## Status (commits on this branch)

| Renderer | Status | Verification |
|---|---|---|
| **Point — tile** (P1.1a, `3f66c086`) | ✅ flipped, raw deleted | DC=0/304200, real GPU |
| **Point — GeoJSON/render()** (P1.2, `4853ef64`) | ✅ flipped, raw pipelines deleted (+ flat variant) | DC=0, 3 fixtures |
| **Heatmap — accum** (P1.3, `133af74e`) | ✅ flipped, raw deleted | within run-to-run noise (r16float accum is non-deterministic) |
| **Raster — render()** (P1.4, `829d5249`+`9896074b`+`0dcb3b53`) | ✅ flipped, raw deleted (+ resampling + pick MRT Materials) | DC=0, offline checker fixture |
| **Line — draws** (P1.5 partial, `424a42d6`+`6d9c64a8`+`ab721d48`) | ◐ opaque + translucent-MAX + composite draws ROUTED behind `__xgisLineViaRhi`; raw still default | DC=0, fixture_translucent_stroke |
| **VTR** (P1.6) | ☐ not started | — |

Adjacent shipped on `feat/shader-dsl-glsl-compute-gpgpu` (M1–M5): shader-codegen SRP (compiler emits
neutral IR; shader-dsl is the sole emitter) + WebGL2 compute→fragment-GPGPU, with 3 real bugs the
real-GPU gate caught (the GLSL switch `break` fall-through fixed every `match()` on WebGL2).

## RHI extensions added (grow-as-needed, each with a live consumer)

- `r32uint` format + `WebGl2Device.dispatchComputeToR32UI` (M4 — WebGL2 compute dispatch).
- `RhiTextureFormat`/blend `'max'` (P1.5 — the translucent-line offscreen MAX accumulation).
- (deferred, needed next) `setIndexBuffer(offset, size)` — the index sub-range for the VTR arena
  (the one blocking RHI primitive per the design; `setVertexBuffer` already carries offset/size).

## ⭐ Verification methodology bank (hard-won — applies to ALL real-GPU render verification here)

1. **NEVER `git stash` to make a pixel baseline while the vite dev server is live.** HMR serves a
   stale/half-built module → a spurious diff that is the harness, not the code (a phantom 1268px
   flat-rim "regression" in P1.2 — the same committed code via stash differed from the clean render by
   the same 1268px). Render the baseline from a CLEAN tree BEFORE applying the change, or toggle a
   runtime flag in-session (no rebuild).
2. **Non-deterministic renderers can't gate on DC=0.** r16float additive accumulation sums in GPU
   fragment-processing order → ~6 LSB run-to-run variation (P1.3 heatmap). Gate on
   `diff <= run-to-run noise floor` (RHI-vs-RHI run1/run2 == raw-vs-RHI), not DC=0.
3. **Network-tile renderers need a deterministic OFFLINE fixture.** raster tiles come from a CDN →
   no stable baseline. `fixture-raster-local.xgis` uses a url with NO `{z}/{x}/{y}` so every tile
   loads the same local `checker-tile.png` → byte-deterministic (P1.4).

## Remaining P1 — VTR fill/extrude (the bulk)

**Line P1.5 is DONE on the draw path** (`96b6360b`): `__xgisLineViaRhi` defaults ON, all 5 draw cases
(opaque / translucent-MAX / composite / pick-MRT / render-bundle) verified real-GPU DC=0. The raw line
pipelines survive ONLY as the `__xgisLineViaRhi === false` fallback and retire with the §4 seam.

VTR **strokes/outlines already route through the RHI** — they call `lineRenderer.drawSegments` (vector-
tile-renderer.ts ~4111/4114), which is now default-ON RHI. So VTR's remaining draws are **fill + extrude
only**, and they share ONE `drawIndexed` method (~3555: `setPipeline` → `setVertexBuffer(0, arena sub-
range)` → optional `setVertexBuffer(1, zBuffer)` for extrude → `setIndexBuffer(arena sub-range)` →
`drawIndexed`). The `setIndexBuffer(offset,size)` RHI gap is CLOSED (`5ff386b4`).

The remaining work is a **polygon Material with the full fill-pipeline variant matrix**
(`pipeline-factory.ts`, ~19 pipelines = the bulk). Axes, all emitted from `emitPolygonWgsl(variantInfo,
pickEnabled)`:
- entryPoint: `vs_main_ecef` (flat) vs `vs_main_ecef_extruded` (3D walls/roof; vertex slot 1 = zBuffer)
- depthWrite: on (`fillPipeline`) vs off (`fillPipelineGround`)
- stencil: none vs `*Fallback` (stencil-test, draw where stencil==0 — the per-tile clip-mask via
  `setStencilReference`, already in `RhiRenderPass`)
- pick: MRT (`fillPipeline`) vs `*NoPick`
- blend/shader: opaque vs `*ExtrudedOIT` vs `*Pattern*` (line-pattern Stage 2) vs overdraw-debug

STRUCTURE (good news — it fits the Material model): the ~19 are pipeline-CONFIG variants of ONE shader
per style. `buildShader(variant)` emits either the default `emitPolygonWgsl(null, pick)` (most tiles) or
a style-specific module (data-driven fill/stroke `Expr`s spliced); the fillPipeline* differ only in
pipeline state (entryPoint / depthWrite / stencil / pick-MRT / blend). So it's a **Material per style**
(shader = `buildShader`) with the ~19 as its `variants[]`, cached like the renderer caches pipelines today.

The fill draw's caller (`recordTileFill`) selects a *pipeline* today; routing means it selects a Material
VARIANT INDEX instead. Build the per-style Material + all config-variants → route the one `drawIndexed` +
the stencil (`setStencilReference`) → verify DC=0 (a VTR polygon scene, e.g. fixture_h2_fill). Then the §4
seam (shared `GPUArena`/bind-group-registry → `Rhi*`) retires the raw line + VTR paths together.

## §4 seam (Rhi* handles, the WebGL2-parity track)

The flips above are WebGPU byte-identical but still wrap raw `GPUBuffer`/`GPUBindGroup` at the draw
site (`wrapWebGpu*`). Closing the seam (resource builders use `rhi.createBuffer`/`createBindGroup`,
batches carry `Rhi*` handles) is what makes them WebGL2-capable. It is a COUPLED cluster:
`ShapeRegistry` (`text/sdf-shape.ts`, shared by point+line), `GPUArena`, and the bind-group registry
all migrate together. `RhiBuffer` has no `destroy()` yet → add `RhiDevice.destroyBuffer` (the
per-frame-rebuild renderers retire buffers). Strategy: flip-first (WebGPU, done for 4.x renderers) →
this seam migration makes them WebGL2-capable.

## After P1: P2 carve `@xgis/engine` → P3 extract `@xgis/map` → P4 runtime thin shell

Per `engine-content-split.md` + `render-graph-pass-scheduler.md`: data-driven `PassDef[]`, invert
`PassHost` → content-supplied `RenderNode`, the §8.5 `engine→@xgis/map import==0` ratchet. Each is a
large phase; gate every one on byte-identity + real-GPU DC=0.
