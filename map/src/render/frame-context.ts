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
   *  screen pass. The label pass branches on it and draws INTO it instead of
   *  originating a sub-pass — on that frame the RHI bridges are null (the
   *  twin holds its one pass open), so requireRhiFrame must never run on the
   *  rhiPass arm. Dies with the twin (#991 P4/P5). */
  rhiPass?: import('@xgis/rhi').RhiRenderPass
  /** The backend RHI device for this frame (`host.ctx.rhi` — the single injected
   *  instance, WebGpuDevice or WebGl2Device). Threaded onto the frame so a pass or
   *  seam can ask the device a capability (`ctx.rhi.caps.*`) instead of branching on
   *  `backend` (#1046 F1, doc §3-F1). F1 is seam-only: the handle is reachable but no
   *  pass reads it yet — byte-identical on both backends. */
  rhi: RhiDevice
  /** The frame's ONE command encoder, RHI-typed (`rhi.acquireFrameEncoder()`,
   *  #1046 F2/F3b — the native trio and the `__xgisRawFrameShell` escape
   *  retired with the Inc-3 field collapse; a native handle exists only as a
   *  loop-local unwrap for the compute/timer tail). Null ONLY on the
   *  forced-WebGL2 twin frame, which holds its one live pass (`rhiPass`)
   *  instead of an encoder — dies with the twin (#991 P4/P5). */
  rhiEncoder: import('@xgis/rhi').RhiCommandEncoder | null
  /** F3b view bridges for the chain passes — the swapchain view, the SCENE
   *  colour attachment (scene-sized MSAA under `useResolve`, the overdraw
   *  accumulator in `?debug=overdraw`, the scene colour while the ladder
   *  scales, else the swapchain view) and the depth-stencil, RHI-wrapped once
   *  per frame (WeakMap-memoized — steady-state frames allocate nothing).
   *  Null ONLY on the twin frame, like `rhiEncoder`. */
  rhiScreenView: import('@xgis/rhi').RhiTextureView | null
  rhiColorView: import('@xgis/rhi').RhiTextureView | null
  rhiStencilView: import('@xgis/rhi').RhiTextureView | null
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
}

/** First-frame FrameContext construction (#1429 piece 6 — the factory the
 *  design said belongs here regardless). The literal is VERBATIM the one the
 *  loop built inline; the loop calls this once, then mutates in place. */
export function makeFrameContext(a: {
  rhi: RhiDevice
  rhiEncoder: FrameContext['rhiEncoder']
  rhiScreenView: FrameContext['rhiScreenView']
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
    rhiEncoder: a.rhiEncoder,
    rhiScreenView: a.rhiScreenView,
    rhiColorView: null, // set by wireFrameColour (F3b bridge)
    rhiStencilView: null, // set by wireFrameColour (F3b bridge)
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

/** The native swapchain view's type, spelled without a raw-WebGPU token — the
 *  loop holds the native view as a LOCAL (the collapse removed it from the
 *  FrameContext surface) and threads it here for `ensure` + identity checks. */
type NativeView = Parameters<RenderTargets['ensure']>[7]

/** Per-frame colour-target wiring: RenderTargets.ensure + the F3b / #1429
 *  bridge population. When colorView IS the swapchain view (sampleCount 1:
 *  mobile / ?safe / ?msaa=1), the device's rebind-per-frame screen wrapper is
 *  reused instead of memo-wrapping a view minted fresh every frame; every
 *  #1429 bridge reduces to an existing wrapper by IDENTITY when the scene is
 *  not scaled (the scale-1 gate pins this). The native views live and die as
 *  loop locals — no pass can reach them (Inc-3 field collapse). */
export function wireFrameColour(
  ctx: FrameContext,
  screenView: NativeView,
  rhiViewFor: (v: NativeView) => NonNullable<FrameContext['rhiScreenView']>,
): void {
  const { rhiScreenView } = ctx
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
  ctx.rhiColorView = colorView === screenView ? rhiScreenView : rhiViewFor(colorView)
  ctx.rhiStencilView = rhiViewFor(ctx.rt.stencilView!)
  ctx.rhiSceneResolveView =
    sceneResolveView === screenView ? rhiScreenView : rhiViewFor(sceneResolveView)
  ctx.rhiColorViewScreen =
    colorViewScreen === colorView
      ? ctx.rhiColorView
      : colorViewScreen === screenView
        ? rhiScreenView
        : rhiViewFor(colorViewScreen)
  ctx.rhiSceneColorSampleView =
    sceneColorSampleView === null ? null : rhiViewFor(sceneColorSampleView)
}
