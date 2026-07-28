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
import { getSampleCount, isPickEnabled } from '@xgis/engine'
import { DEBUG_OVERDRAW } from '../debug-flags'

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

/** Point the two targets at their geometries. INC-1 landed this with both equal ("the split
 *  exists, nothing renders differently"); INC-2 (#1429) makes the SCENE the one the adaptive
 *  ladder may hold below native — `sceneScale` is `adaptiveDprScale()` on the WebGPU chain and
 *  1 on the twin (which scales its CANVAS instead, design §7). ONE site so the loop's two
 *  population branches (first frame / reuse) cannot drift apart. Mutates in place — the loop
 *  is allocation-paranoid and both sub-objects outlive the frame. */
export function setFrameTargets(
  c: FrameContext,
  w: number,
  h: number,
  dpr: number,
  sceneScale = 1,
): void {
  c.scene.w = Math.max(1, Math.round(w * sceneScale))
  c.scene.h = Math.max(1, Math.round(h * sceneScale))
  c.scene.dpr = dpr * sceneScale
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
  /** The colour attachment the SCENE passes draw into:
   *  the (scene-sized) MSAA texture view when `useResolve`, the overdraw
   *  accumulator in `?debug=overdraw`, the scene colour when the ladder holds
   *  the scene below native (#1429 INC-2), else `screenView` directly.
   *  Populated AFTER the MSAA/stencil texture management block. */
  colorView: GPUTextureView
  /** #1429 INC-2 — where the resolve-owner SCENE pass resolves its MSAA: the
   *  scene colour while scaled, else the screen view (IDENTITY to the
   *  pre-split target — the scale-1 gate pins that). RHI-only: every ported
   *  pass reads through requireRhiFrame, so no native twin exists for a pass
   *  to reach past the seam. */
  rhiSceneResolveView: import('@xgis/rhi').RhiTextureView | null
  /** #1429 INC-2 — the colour attachment the SEAM + OVERLAY passes draw
   *  into: the screen-sized MSAA while scaled (labels keep the final
   *  resolve), else exactly the scene colour attachment. RHI-only, as above. */
  rhiColorViewScreen: import('@xgis/rhi').RhiTextureView | null
  /** #1429 INC-2 — the resolved scene colour as the upscale seam's sample
   *  source (RHI handle; the seam is RHI-native from birth). Null unless the
   *  ladder holds the scene below native this frame. */
  rhiSceneColorSampleView: import('@xgis/rhi').RhiTextureView | null
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

/** First-frame FrameContext construction (#1429 piece 6 — the factory the
 *  design said belongs here regardless). The literal is VERBATIM the one the
 *  loop built inline; the loop calls this once, then mutates in place. */
export function makeFrameContext(a: {
  rhi: RhiDevice
  encoder: FrameContext['encoder']
  rhiEncoder: FrameContext['rhiEncoder']
  rhiScreenView: FrameContext['rhiScreenView']
  screenView: FrameContext['screenView']
  camera: Camera
  projection: ProjectionToken
  w: number
  h: number
  dpr: number
  elapsedMs: number
  frameCount: number
  passScope: FrameContext['passScope']
  rt: RenderTargets
}): FrameContext {
  return {
    // The single injected RHI device (immutable across the loop's lifetime —
    // render-context.ts: "the SINGLE instance every renderer routes through"),
    // so it is set once here; the loop's reuse branch leaves it in place (#1046 F1).
    rhi: a.rhi,
    encoder: a.encoder,
    rhiEncoder: a.rhiEncoder,
    rhiScreenView: a.rhiScreenView,
    rhiColorView: null, // set by wireFrameColour (F3b bridge)
    rhiStencilView: null, // set by wireFrameColour (F3b bridge)
    screenView: a.screenView,
    colorView: a.screenView, // set by wireFrameColour
    // #1429 INC-2 seam bridges — set by wireFrameColour.
    rhiSceneResolveView: null,
    rhiColorViewScreen: null,
    rhiSceneColorSampleView: null,
    camera: a.camera,
    projection: a.projection,
    scene: { w: a.w, h: a.h, dpr: a.dpr },
    screen: { w: a.w, h: a.h, dpr: a.dpr },
    elapsedMs: a.elapsedMs,
    frameCount: a.frameCount,
    sampleCount: 1, // set by wireFrameColour
    useResolve: false, // set by wireFrameColour
    passScope: a.passScope,
    rt: a.rt,
  }
}

/** Per-frame colour-target wiring: RenderTargets.ensure + the F3b / #1429
 *  bridge population, extracted VERBATIM from the loop's MSAA block. When
 *  colorView IS the swapchain view (sampleCount 1: mobile / ?safe / ?msaa=1),
 *  the device's rebind-per-frame screen wrapper is reused instead of
 *  memo-wrapping a view minted fresh every frame; every #1429 bridge reduces
 *  to an existing wrapper by IDENTITY when the scene is not scaled (the
 *  scale-1 gate pins this). Null bridges under the raw-shell escape — ported
 *  passes fail loud there via requireRhiFrame. */
export function wireFrameColour(
  ctx: FrameContext,
  rawFrameShell: boolean,
  rhiViewFor: (v: FrameContext['screenView']) => NonNullable<FrameContext['rhiScreenView']>,
): void {
  const { screenView, rhiScreenView } = ctx
  const sc = getSampleCount()
  ctx.sampleCount = sc
  const { useResolve, colorView, sceneResolveView, colorViewScreen, sceneColorSampleView } =
    ctx.rt.ensure(
      ctx.scene.w,
      ctx.scene.h,
      ctx.screen.w,
      ctx.screen.h,
      sc,
      isPickEnabled(),
      DEBUG_OVERDRAW,
      screenView,
    )
  ctx.useResolve = useResolve
  ctx.colorView = colorView
  ctx.rhiColorView = rawFrameShell
    ? null
    : colorView === screenView
      ? rhiScreenView
      : rhiViewFor(colorView)
  ctx.rhiStencilView = rawFrameShell ? null : rhiViewFor(ctx.rt.stencilView!)
  ctx.rhiSceneResolveView = rawFrameShell
    ? null
    : sceneResolveView === screenView
      ? rhiScreenView
      : rhiViewFor(sceneResolveView)
  ctx.rhiColorViewScreen = rawFrameShell
    ? null
    : colorViewScreen === colorView
      ? ctx.rhiColorView
      : colorViewScreen === screenView
        ? rhiScreenView
        : rhiViewFor(colorViewScreen)
  ctx.rhiSceneColorSampleView =
    rawFrameShell || sceneColorSampleView === null ? null : rhiViewFor(sceneColorSampleView)
}
