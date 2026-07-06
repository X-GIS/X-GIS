// ═══ X-GIS RenderLoop — per-frame FrameContext value object ═══
//
// Bundles the per-frame derived scalars + GPU handles that `RenderLoop.render`
// computes near the top of every frame (and the few derived deep inside the
// label block) into ONE struct. This is a pure bundling of locals — every
// field is assigned at the EXACT point the corresponding local was computed
// before, in the same order, so behaviour is byte-identical.
//
// CRITICAL: RenderLoop holds a SINGLE reused instance (`_ctx`) and mutates it
// in place each frame. The 60 Hz render loop is allocation-paranoid; a fresh
// FrameContext per frame would defeat the GC-pressure work that motivated the
// arena / scratch-reuse patterns elsewhere in the path. The fields are all
// `let`-style (mutable) for that reason.

import type { Camera } from '@xgis/engine'
import type { RenderTargets } from './render-targets'
import type { ProjectionToken } from '@xgis/engine'

/** Per-frame render state. One reused instance lives on RenderLoop; its
 *  fields are (re)populated at the start of each `render()` at the same
 *  points the equivalent locals were computed before this struct existed. */
export interface FrameContext {
  /** Set ONLY by the forced-WebGL2 frame (#834 M5 slice 3): the live RHI
   *  screen pass. A pass that draws overlay content (labels) branches on it
   *  instead of encoding a WebGPU render pass — the other FrameContext
   *  fields (`encoder`, `colorView`, …) are proxy no-ops there. */
  rhiPass?: import('@xgis/rhi').RhiRenderPass
  /** The WebGPU device (from `host.ctx.device`). */
  device: GPUDevice
  /** This frame's command encoder (`device.createCommandEncoder()`). */
  encoder: GPUCommandEncoder
  /** The swapchain texture view for this frame
   *  (`context.getCurrentTexture().createView()`). */
  screenView: GPUTextureView
  /** The colour attachment the opaque/translucent passes draw into:
   *  the MSAA texture view when `useResolve`, the overdraw accumulator in
   *  `?debug=overdraw`, else `screenView` directly. Populated AFTER the
   *  MSAA/stencil texture management block (it depends on `useResolve`). */
  colorView: GPUTextureView
  /** The owning map's camera (live reference, not a snapshot). */
  camera: Camera
  /** Opaque projection handle (projection-token.ts). The engine transports it
   *  but cannot decode it; only content unwraps it (`unwrapProjection`) for its
   *  draw/shader signatures — the projType / RTC-centre triple that used to live
   *  here as loose scalars (P2-carve §3: FrameContext is projection-blind). */
  projection: ProjectionToken
  /** Canvas width / height in physical pixels (`canvas.width/height`). */
  w: number
  h: number
  /** Device pixel ratio (capped by `getMaxDpr()`), 1 outside the browser. */
  dpr: number
  /** Wall-clock ms since the first rendered frame (mirror of
   *  `host._elapsedMs`, the time-interpolation clock). */
  elapsedMs: number
  /** Monotonic frame counter at the START of this frame (mirror of
   *  `host._frameCount` before the tail increment). */
  frameCount: number
  /** MSAA sample count (`getSampleCount()`): 1 on mobile / ?safe / msaa=1,
   *  4 on desktop default. */
  sampleCount: number
  /** `sampleCount > 1` — whether passes resolve MSAA to the swapchain. */
  useResolve: boolean
  /** Per-pass validation-scope + perf-marks helper. Re-bound each frame
   *  because it closes over this frame's `device`. */
  passScope: (label: string, fn: () => void) => void
  /** The owning map's RenderTargets (live reference). Passes read its
   *  textures (stencil / oitAccum / oitRevealage / pick / overdrawAccum)
   *  for their render-pass attachments. */
  rt: RenderTargets
  /** True under the forced-WebGL2 boot (`?forcegl2=1` → `host.ctx.rhi != null`).
   *  Selects the RHI screen-pass lifecycle for the raster slice instead of the raw
   *  WebGPU encoder path. Populated at the FrameContext build site from
   *  `host.ctx.rhi != null`; undefined/false on the normal WebGPU path (the loop then
   *  takes the unchanged raw-WebGPU branch). The handle itself is reached as
   *  `host.ctx.rhi`; this flag is only the per-frame branch predicate. */
  useRhi?: boolean
}
