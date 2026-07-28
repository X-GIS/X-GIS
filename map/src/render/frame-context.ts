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
   *  Null under `__xgisRawFrameShell=true`, which mints the native encoder directly and has
   *  no RHI wrapper to offer. Since the F3b pass ports, that escape is NO LONGER a working
   *  whole-frame rollback: a ported pass fails loud on the null bridge (requireRhiFrame)
   *  rather than render a wrong frame; only the unported bodies still honour it. It
   *  retires with the F3b field collapse. */
  rhiEncoder: import('@xgis/rhi').RhiCommandEncoder | null
  /** F3b parallel RHI handles for the ported chain passes — the same targets as
   *  `screenView` / `colorView` / `rt.stencilView`, RHI-wrapped once per frame by
   *  the loop (WeakMap-memoized on the native view, so steady-state frames
   *  allocate nothing). Null under `__xgisRawFrameShell=true`, where a ported
   *  pass fails loud instead of rendering a wrong frame (`requireRhiFrame`).
   *  The F3b field collapse retires the native trio and these bridges together. */
  rhiScreenView: import('@xgis/rhi').RhiTextureView | null
  rhiColorView: import('@xgis/rhi').RhiTextureView | null
  rhiStencilView: import('@xgis/rhi').RhiTextureView | null
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
