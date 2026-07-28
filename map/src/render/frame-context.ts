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

import type { Camera } from '../camera'
import type { RhiDevice } from '@xgis/rhi'
import type { RenderTargets } from '@xgis/rhi-webgpu'
import type { ProjectionToken } from './projection-token'

/** One render target's pixel geometry.
 *
 *  Two of these ride every frame — see {@link FrameContext.scene} and
 *  {@link FrameContext.screen}. They are EQUAL today; the split exists so that when the
 *  adaptive-DPR ladder shrinks the scene (docs/architecture/design/overlay-native-resolution.md)
 *  a pass cannot reach for "the" size without saying WHICH, because there is no such field to
 *  reach for. Getting it wrong is a name that does not exist, not an offset nobody notices.
 *
 *  INVARIANT, and the reason the camera needs no change when they diverge: `h / dpr` is the
 *  CSS height and is the SAME for both, because both are the same CSS box measured at a
 *  different pixel density. Every camera/MVP quantity is derived from that ratio or from clip
 *  space, and clip space is resolution-independent — so a view built for one target is correct
 *  for the other. Only quantities counted in DEVICE pixels differ. */
export interface TargetGeometry {
  /** Width / height in physical pixels. */
  w: number
  h: number
  /** Device pixels per CSS pixel for THIS target. */
  dpr: number
}

/** Point BOTH targets at one geometry — which is the whole of INC-1: the split exists, the two
 *  are equal, nothing renders differently. Lives here rather than inline in the render loop so
 *  the "they are the same until INC-2 says otherwise" statement has ONE site to change, and so
 *  the loop's two population branches (first frame / reuse) cannot drift apart. Mutates in
 *  place — the loop is allocation-paranoid and both sub-objects outlive the frame. */
export function setFrameTargets(c: FrameContext, w: number, h: number, dpr: number): void {
  c.scene.w = w
  c.scene.h = h
  c.scene.dpr = dpr
  c.screen.w = w
  c.screen.h = h
  c.screen.dpr = dpr
}

/** Per-frame render state. One reused instance lives on RenderLoop; its
 *  fields are (re)populated at the start of each `render()` at the same
 *  points the equivalent locals were computed before this struct existed. */
export interface FrameContext {
  /** Set ONLY by the forced-WebGL2 frame (#834 M5 slice 3): the live RHI
   *  screen pass. A pass that draws overlay content (labels) branches on it
   *  instead of encoding a WebGPU render pass — the other FrameContext
   *  fields (`encoder`, `colorView`, …) are proxy no-ops there. */
  rhiPass?: import('@xgis/rhi').RhiRenderPass
  /** The backend RHI device for this frame (`host.ctx.rhi` — the single injected
   *  instance, WebGpuDevice or WebGl2Device). Threaded onto the frame so a pass or
   *  seam can ask the device a capability (`ctx.rhi.caps.*`) instead of branching on
   *  `backend` (#1046 F1, doc §3-F1). F1 is seam-only: the handle is reachable but no
   *  pass reads it yet — byte-identical on both backends. */
  rhi: RhiDevice
  /** This frame's command encoder. F2 (#1046) sources it through the RHI
   *  (`rhi.acquireFrameEncoder()`) instead of the raw `device.createCommandEncoder()`;
   *  the native handle is unwrapped for the not-yet-converted passes (still typed
   *  `GPUCommandEncoder` here — the pass-body retype to `RhiCommandEncoder` is F3/P5).
   *  The former pass-visible `device: GPUDevice` field is gone (F2 "drops device from
   *  the pass-visible surface", doc §3-F2): it was write-only — no pass read it. */
  encoder: GPUCommandEncoder
  /** The SAME frame encoder, still RHI-typed — the handle `encoder` above is the unwrapped
   *  native view of. A pass whose body already routes through the RHI (the flow pass, #1333)
   *  takes this one and never names a WebGPU type; the not-yet-converted bodies keep taking
   *  `encoder`. This is the F3/P5 direction arriving one pass at a time, not a second encoder:
   *  both fields are the one per-frame encoder the loop submits once.
   *
   *  Null under `__xgisRawFrameShell=true` (the one-release raw-shell rollback), which mints
   *  the native encoder directly and has no RHI wrapper to offer. */
  rhiEncoder: import('@xgis/rhi').RhiCommandEncoder | null
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
  /** The SCENE target's geometry — where the world is rasterised (background →
   *  flow → opaque → oit → translucent → hillshade → points → heatmap). This is
   *  the target the adaptive-DPR ladder is allowed to shrink. */
  scene: TargetGeometry
  /** The SCREEN (swapchain) target's geometry — where the OVERLAY is rasterised
   *  (labels, graphics) and what the browser presents. */
  screen: TargetGeometry
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
