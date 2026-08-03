// ═══ X-GIS RenderTargets — GPU render-target texture lifecycle ═══
//
// Owns the per-frame GPU render-target textures + their size tracking,
// extracted VERBATIM from the MSAA/stencil texture-management block at the
// top of `RenderLoop.render` (and the trailing colorView decision). This is
// a RELOCATION, not a redesign: the texture formats, usages, destroy-old
// order, recreate-on-resize gate, and colorView choice are byte-identical to
// the inline block. The 9 fields (msaa/msaaWidth/msaaHeight/stencil/pick/
// oitAccum/oitRevealage/offscreenExtrudeDepth/overdrawAccum) moved OFF
// XGISMap onto this class; readers that used to reach `host.X` now read
// `renderTargets.X`. The pick texture is additionally surfaced to the pick
// path via `XGISMap.pickTexture` delegating here.
//
// CRITICAL: behaviour is pixel-identical. `ensure()` recreates exactly when
// the inline gate did (no stencil yet, or w/h changed) and in the same
// destroy → recreate order; setQuality() zeroes the size tracker the same
// way (now via `invalidate()`).
//
// #1046 F4 Inc-D: allocation runs through the neutral `RhiDevice` texture
// primitives (`ctx.rhi`, never `ctx.device` — the WebGL2 chain frame's ctx
// carries a fail-loud device Proxy) and every view getter hands out an
// RhiTextureView. The three `*Native` getters below are the ONLY native
// residue, scoped to the raw compose bind groups (P6).

import { OIT_ACCUM_FORMAT, OIT_REVEALAGE_FORMAT } from './gpu-shared'
import type { GPUContext } from './gpu'
import { unwrapWebGpuTextureView } from './rhi-webgpu'
import type { RhiDevice, RhiTexture, RhiTextureView } from '@xgis/rhi'

/** Result of `RenderTargets.ensure` — the per-frame colour-attachment
 *  decision that depends on `sampleCount` / `debugOverdraw` / the adaptive
 *  scene scale (#1429 INC-2). When the scene is NOT scaled every field
 *  reduces to its pre-split value by IDENTITY (`colorViewScreen ===
 *  colorView`, `sceneResolveView === screenView`, `sceneColorSampleView
 *  null`) — the scale-1 constructive no-op gate pins that. */
export interface EnsureResult {
  /** `sampleCount > 1` — whether passes resolve MSAA. */
  useResolve: boolean
  /** The colour attachment SCENE passes draw into: the overdraw accumulator
   *  in `?debug=overdraw`, the (scene-sized) MSAA texture view when
   *  `useResolve`, else the scene colour (scaled) / `screenView` directly. */
  colorView: RhiTextureView
  /** #1429 INC-2 — true when the adaptive ladder shrank the scene target
   *  below the canvas (`sceneW/H !== screenW/H`): the scene pair exists and
   *  the upscale seam must run. */
  sceneScaled: boolean
  /** Where the resolve-owner scene pass resolves its MSAA: the scene colour
   *  when scaled, else `screenView` (the pre-split target). */
  sceneResolveView: RhiTextureView
  /** The colour attachment the SEAM + OVERLAY passes draw into: the
   *  screen-sized MSAA when scaled (labels still own the final resolve),
   *  else exactly `colorView` (one attachment, as today). */
  colorViewScreen: RhiTextureView
  /** The resolved scene colour as a sampleable view — the upscale's source.
   *  `null` unless scaled. */
  sceneColorSampleView: RhiTextureView | null
}

/** Owns the GPU render-target textures + recreate-on-resize lifecycle. The
 *  textures stay package-internal (read by RenderLoop + the pick path); this
 *  class is the single owner. */
export class RenderTargets {
  /** Stencil buffer for tile overlap masking. */
  stencilTexture: RhiTexture | null = null
  /** MSAA 4x render target (only allocated when sampleCount > 1). */
  msaaTexture: RhiTexture | null = null
  /** Weighted-Blended OIT accum target (rgba16float). Lazily allocated by
   *  `ensureOit()` ONLY when the scene has OIT-extrude content (default
   *  styles keep `isOitExtrude=false`, so the default path allocates none of
   *  the ~10 B/px these two targets cost). Lazy, like the (map-owned) heatmap
   *  density targets. */
  oitAccumTexture: RhiTexture | null = null
  /** Weighted-Blended OIT revealage target (r16float). Lazy — see above. */
  oitRevealageTexture: RhiTexture | null = null
  /** Fresh depth for the two-pass offscreen extrude pass. Lazy (allocated
   *  alongside the OIT targets in `ensureOit()`) — kept for the future OIT
   *  opt-in path; unread on the default path so allocating it eagerly was
   *  pure waste. */
  offscreenExtrudeDepth: RhiTexture | null = null
  /** `?debug=overdraw` r16float accumulator. */
  overdrawAccumTexture: RhiTexture | null = null
  /** Pick (GPU hover/click) RG32Uint single-sample colour attachment. */
  pickTexture: RhiTexture | null = null
  /** #1429 INC-2 — the resolved scene colour at SCENE size. Allocated ONLY
   *  while the adaptive ladder holds the scene below native (`sceneScaled`):
   *  the resolve destination when MSAA is on, the direct scene write target
   *  when it is off, and always the upscale seam's sample source. */
  sceneColorTexture: RhiTexture | null = null
  /** #1429 INC-2 — the screen-sized MSAA the SEAM + OVERLAY passes draw
   *  into while scaled (labels resolve it to the swapchain, exactly as they
   *  resolved the one MSAA before the split). Allocated only when scaled AND
   *  `sampleCount > 1`. */
  screenMsaaTexture: RhiTexture | null = null

  // ── Self-healing texture-view cache ──
  // A createView() returns a FRESH view each call; the passes used to mint
  // one EVERY frame for stencil/pick/oit/msaa/overdraw (4–8 allocations/
  // frame). The backing textures only change on resize, so we cache the view
  // keyed on the texture IDENTITY: the getters below derive-and-cache through
  // `viewOf`, which (re)creates the view IFF the underlying texture object
  // changed. This makes the cache impossible to desync — a future
  // texture-recreation site needs no companion "update the view"
  // bookkeeping, and a stale view can never be handed to a render pass.
  // ONE cache for both frame shapes (#1046 F4 Inc-D — the native/RHI twin
  // caches collapsed with the RhiTexture retype). The swapchain view stays
  // per-frame (a fresh acquire each frame) and is never cached here. WeakMap
  // so a retired texture's entry is GC'd with the texture; no manual
  // eviction on resize.
  private readonly _viewCache = new WeakMap<RhiTexture, RhiTextureView>()
  private viewOf(tex: RhiTexture): RhiTextureView {
    let v = this._viewCache.get(tex)
    if (v === undefined) {
      v = this.getCtx().rhi.createView(tex)
      this._viewCache.set(tex, v)
    }
    return v
  }
  /** Cached default view of `stencilTexture` (null until `ensure`). */
  get stencilView(): RhiTextureView | null {
    return this.stencilTexture ? this.viewOf(this.stencilTexture) : null
  }
  /** Cached default view of `pickTexture` (null when picking disabled). */
  get pickView(): RhiTextureView | null {
    return this.pickTexture ? this.viewOf(this.pickTexture) : null
  }
  /** Cached default view of `msaaTexture` (null when sampleCount === 1). */
  get msaaView(): RhiTextureView | null {
    return this.msaaTexture ? this.viewOf(this.msaaTexture) : null
  }
  /** Cached default view of `overdrawAccumTexture` (null unless `?debug=overdraw`). */
  get overdrawView(): RhiTextureView | null {
    return this.overdrawAccumTexture ? this.viewOf(this.overdrawAccumTexture) : null
  }
  /** Cached default view of `oitAccumTexture` (null until `ensureOit`). */
  get oitAccumView(): RhiTextureView | null {
    return this.oitAccumTexture ? this.viewOf(this.oitAccumTexture) : null
  }
  /** Cached default view of `oitRevealageTexture` (null until `ensureOit`). */
  get oitRevealageView(): RhiTextureView | null {
    return this.oitRevealageTexture ? this.viewOf(this.oitRevealageTexture) : null
  }
  // ── Native residue (P6) ──
  // The overdraw/OIT COMPOSE draws still build their bind groups on the raw
  // device (frame-renderer.drawOitCompose / overdraw-compose-pass) — native
  // pipelines until the compose moves onto a Material. These unwrap the SAME
  // cached view (identity-stable per texture; the unwrap is a property
  // read). WebGPU-only consumers; they retire with the P6 compose port.
  /** Native form of `overdrawView` for the raw compose bind group (P6). */
  get overdrawViewNative(): GPUTextureView | null {
    return this.overdrawAccumTexture
      ? unwrapWebGpuTextureView(this.viewOf(this.overdrawAccumTexture))
      : null
  }
  /** Native form of `oitAccumView` for the raw compose bind group (P6). */
  get oitAccumViewNative(): GPUTextureView | null {
    return this.oitAccumTexture ? unwrapWebGpuTextureView(this.viewOf(this.oitAccumTexture)) : null
  }
  /** Native form of `oitRevealageView` for the raw compose bind group (P6). */
  get oitRevealageViewNative(): GPUTextureView | null {
    return this.oitRevealageTexture
      ? unwrapWebGpuTextureView(this.viewOf(this.oitRevealageTexture))
      : null
  }
  /** Size the SCENE-side textures were last allocated at (recreate gate).
   *  Pre-#1429 this was the one canvas size; it is now the scene size, which
   *  the ladder can move while the canvas is unchanged. */
  msaaWidth = 0
  msaaHeight = 0
  /** The pick texture's pixel size — the SAME scene tracker (`pickTexture` is
   *  minted in the block that sets it, so the two cannot disagree). Surfaced
   *  because RhiTexture is opaque: the pick READ derives its coordinate from
   *  the texture being read (#1429 single authority), and `tex.width` no
   *  longer exists to read. Pick-path frequency (not per-frame), so the
   *  result object is minted per call. */
  pickSize(): { width: number; height: number } {
    return { width: this.msaaWidth, height: this.msaaHeight }
  }
  /** #1429 INC-2 — the scaled pair's own tracker (scene and screen resize
   *  independently — a ladder notch moves the scene while the canvas is
   *  unchanged, a window resize moves both; `0` means "not allocated",
   *  which is also the not-scaled steady state). */
  private screenPairW = 0
  private screenPairH = 0
  private scenePairW = 0
  private scenePairH = 0
  private screenPairSc = 0
  /** Size + sample count the OIT targets were last allocated at — a separate
   *  tracker so the lazily-allocated OIT block resizes independently of the
   *  main MSAA block and recreates when the sample count changes. */
  private oitWidth = 0
  private oitHeight = 0
  private oitSampleCount = 0
  /** The RhiDevice every currently-cached target was allocated on. `null`
   *  until the first `ensure*`. Drives the device-identity guard below. */
  private _device: RhiDevice | null = null

  private readonly getCtx: () => GPUContext

  constructor(getCtx: () => GPUContext) {
    this.getCtx = getCtx
  }

  /** The device the currently-cached targets were allocated on (`null` until
   *  the first `ensure*`). Every cached texture — including `pickTexture` — is
   *  minted inside `ensure*` on this device and dropped when it changes
   *  (`syncDevice`), so it is authoritative for "which device owns the pick
   *  texture". The pick path compares this against `ctx.rhi` to skip a
   *  cross-device readback in the window between a `map.run()` re-init and
   *  the first post-swap frame (#792). */
  get device(): RhiDevice | null {
    return this._device
  }

  /** Force the next `ensure()` to reallocate even when w/h are unchanged
   *  (used by setQuality after an msaa/picking sampleCount change). Mirrors
   *  the old `host.msaaWidth = 0; host.msaaHeight = 0`. */
  invalidate(): void {
    this.msaaWidth = 0
    this.msaaHeight = 0
  }

  /** Device-identity guard, run at the top of every `ensure*`. Each cached
   *  render target is bound to the RhiDevice it was allocated on. A
   *  `map.run()` re-entry (scene swap) tears down the old device
   *  (`_teardownForReinit` → `device.destroy()`) and acquires a NEW one, but
   *  the canvas size is unchanged — so the size-keyed recreate gates below
   *  all short-circuit and hand a render pass on the NEW device a color /
   *  stencil attachment still owned by the DESTROYED device ("TextureView …
   *  associated with [Device], cannot be used with [Device]" → the frame
   *  fails at BeginRenderPass and the map blanks, #737). Keying every
   *  `ensure*` on the device makes this class self-heal on ANY device swap
   *  (re-run today, device-lost recovery tomorrow) with no caller
   *  bookkeeping: on a new device, drop every cached texture + zero every
   *  size tracker so the next `ensure*` reallocates fresh on the live device.
   *  The old textures are already freed with the destroyed device, so they
   *  are nulled (not destroyed) here — the `_viewCache` WeakMap sheds their
   *  entries with them. A no-op on the first call and on every same-device
   *  frame (`===` early-out), so the steady-state path is byte-identical. */
  private syncDevice(rhi: RhiDevice): void {
    if (rhi === this._device) return
    this._device = rhi
    this.stencilTexture = null
    this.msaaTexture = null
    this.pickTexture = null
    this.overdrawAccumTexture = null
    this.oitAccumTexture = null
    this.oitRevealageTexture = null
    this.offscreenExtrudeDepth = null
    this.sceneColorTexture = null
    this.screenMsaaTexture = null
    this.msaaWidth = 0
    this.msaaHeight = 0
    this.screenPairW = 0
    this.screenPairH = 0
    this.scenePairW = 0
    this.scenePairH = 0
    this.screenPairSc = 0
    this.oitWidth = 0
    this.oitHeight = 0
    this.oitSampleCount = 0
  }

  /** (Re)allocate the render-target textures when missing or resized, then
   *  return the per-frame colorView decision. The SCENE-side block is the
   *  VERBATIM port of the inline MSAA/stencil management (same formats,
   *  usages, destroy-old order, recreate-on-resize gate), now sized from
   *  SCENE pixels; the screen-side pair (#1429 INC-2) exists ONLY while the
   *  adaptive ladder holds `sceneW/H` below `screenW/H`. When not scaled the
   *  allocation AND the returned views are byte-identical to the pre-split
   *  code — a host that never trips the ladder cannot be regressed. */
  ensure(
    sceneW: number,
    sceneH: number,
    screenW: number,
    screenH: number,
    sampleCount: number,
    pickEnabled: boolean,
    debugOverdraw: boolean,
    screenView: RhiTextureView,
  ): EnsureResult {
    // `ctx.rhi`, NEVER `ctx.device` — the WebGL2 chain frame's GPUContext
    // carries a fail-loud Proxy at `device`; touching it is a crash on
    // frame one (flip blocker #1, pinned by the booby-trapped ensure test).
    const { rhi, format } = this.getCtx()
    this.syncDevice(rhi)
    const sc = sampleCount
    const useResolve = sc > 1
    const sceneScaled = sceneW !== screenW || sceneH !== screenH
    const w = sceneW
    const h = sceneH
    if (!this.stencilTexture || this.msaaWidth !== w || this.msaaHeight !== h) {
      if (this.msaaTexture) rhi.destroyTexture(this.msaaTexture)
      if (this.stencilTexture) rhi.destroyTexture(this.stencilTexture)
      if (this.pickTexture) rhi.destroyTexture(this.pickTexture)
      if (this.overdrawAccumTexture) rhi.destroyTexture(this.overdrawAccumTexture)
      this.overdrawAccumTexture = null
      // Allocate the MSAA color attachment ONLY when MSAA is on. When
      // sc === 1 we render straight to the target (no resolveTarget)
      // and the MSAA texture would just waste w×h×4 bytes per frame.
      this.msaaTexture = useResolve
        ? rhi.createTexture({
            width: w,
            height: h,
            format,
            sampleCount: sc,
            usage: ['render'],
          })
        : null
      this.stencilTexture = rhi.createTexture({
        width: w,
        height: h,
        format: 'depth24plus-stencil8',
        sampleCount: sc,
        usage: ['render'],
      })
      // Pick RT: RG32Uint, single-sample. `?picking=1` forces SAMPLE_COUNT
      // to 1 globally (see quality.ts) so sc === 1 here whenever PICK is
      // true — the pick attachment and color attachment share sample count
      // as WebGPU requires. Scene-sized: it is a scene-pass attachment, and
      // the pick READ derives its coordinate from this texture's own size
      // (single authority, surfaced as `pickSize()`), so the two cannot
      // disagree.
      this.pickTexture = pickEnabled
        ? rhi.createTexture({
            width: w,
            height: h,
            format: 'rg32uint',
            sampleCount: 1,
            usage: ['render', 'copy-src'],
          })
        : null
      // The OIT + offscreen-extrude targets are NOT allocated here — they
      // move to the lazy `ensureOit()` (gated on scene OIT content), the
      // same way the map-owned heatmap density targets gate on
      // `scene.hasHeatmap`. On a resize the stale OIT targets are
      // size-mismatched; the next `ensureOit()` recreates them via its own tracker.
      if (debugOverdraw) {
        // r16float lets per-pixel additive accumulation grow well
        // past the [0, 1] swapchain range. MSAA forced to 1× in
        // quality.ts when debug=overdraw, so sampleCount=1 here.
        this.overdrawAccumTexture = rhi.createTexture({
          width: w,
          height: h,
          format: 'r16float',
          sampleCount: 1,
          usage: ['render', 'sample'],
          label: 'overdraw-accum',
        })
      }
      this.msaaWidth = w
      this.msaaHeight = h
    }

    // ── #1429 INC-2: the screen-side pair, only while scaled ──
    // sceneColor is the resolved scene at scene size (resolve destination
    // under MSAA, direct scene write target without it, always the seam's
    // sample source); screenMsaa is the native-sized MSAA the seam + overlay
    // draw into (labels keep the final resolve). Not scaled ⇒ both retire —
    // `screenPairW = 0` is also the steady state, so a host that never trips
    // the ladder never allocates a byte here.
    if (sceneScaled) {
      if (
        !this.sceneColorTexture ||
        this.screenPairW !== screenW ||
        this.screenPairH !== screenH ||
        this.scenePairW !== w ||
        this.scenePairH !== h ||
        this.screenPairSc !== sc
      ) {
        if (this.sceneColorTexture) rhi.destroyTexture(this.sceneColorTexture)
        if (this.screenMsaaTexture) rhi.destroyTexture(this.screenMsaaTexture)
        this.sceneColorTexture = rhi.createTexture({
          width: w,
          height: h,
          format,
          sampleCount: 1,
          usage: ['render', 'sample'],
          label: 'scene-color',
        })
        this.screenMsaaTexture = useResolve
          ? rhi.createTexture({
              width: screenW,
              height: screenH,
              format,
              sampleCount: sc,
              usage: ['render'],
              label: 'screen-msaa',
            })
          : null
        this.screenPairW = screenW
        this.screenPairH = screenH
        this.scenePairW = w
        this.scenePairH = h
        this.screenPairSc = sc
      }
    } else if (this.sceneColorTexture || this.screenMsaaTexture) {
      if (this.sceneColorTexture) rhi.destroyTexture(this.sceneColorTexture)
      if (this.screenMsaaTexture) rhi.destroyTexture(this.screenMsaaTexture)
      this.sceneColorTexture = null
      this.screenMsaaTexture = null
      this.screenPairW = 0
      this.screenPairH = 0
      this.scenePairW = 0
      this.scenePairH = 0
      this.screenPairSc = 0
    }

    // When SAMPLE_COUNT === 1 (mobile / no MSAA), render DIRECTLY to the
    // target texture and never set a resolveTarget — single-sample
    // attachments cannot have a resolve target per WebGPU spec. Scaled, the
    // direct target is the scene colour; native, it is the swapchain view.
    //
    // `?debug=overdraw` reroutes every opaque/translucent pass into the
    // r16float accumulator instead. A trailing compose pass at the end
    // of the frame samples the accumulator and writes the colormap to
    // the swapchain. Translucent/OIT paths still run — their debug
    // pipeline mirrors emit into the same accumulator with additive
    // blend, so the heatmap counts every contributing draw.
    const sceneColorView = this.sceneColorTexture ? this.viewOf(this.sceneColorTexture) : null
    const colorView = debugOverdraw
      ? this.overdrawView!
      : useResolve
        ? this.msaaView!
        : sceneScaled
          ? sceneColorView!
          : screenView
    // Where the resolve-owner scene pass resolves; what the seam samples;
    // what the seam + overlay write. All three reduce to the pre-split
    // values by IDENTITY when not scaled.
    const sceneResolveView = sceneScaled ? sceneColorView! : screenView
    const colorViewScreen = sceneScaled
      ? useResolve
        ? this.viewOf(this.screenMsaaTexture!)
        : screenView
      : colorView
    return {
      useResolve,
      colorView,
      sceneScaled,
      sceneResolveView,
      colorViewScreen,
      sceneColorSampleView: sceneScaled ? sceneColorView : null,
    }
  }

  /** Lazily (re)allocate the OIT targets (accum + revealage + offscreen-
   *  extrude depth) at canvas size + sample count. Called from the OIT pass
   *  ONLY when `scene.hasOit` — the default style keeps `isOitExtrude=false`
   *  so this never fires and the ~10 B/px the accum + revealage cost (plus
   *  the extrude depth) is never allocated. `sampleCount` matches the opaque
   *  pass so the OIT fill can share the opaque depth attachment. Recreates on
   *  resize or sample-count change via the dedicated tracker. */
  ensureOit(w: number, h: number, sampleCount: number): void {
    const { rhi } = this.getCtx()
    this.syncDevice(rhi)
    if (
      this.oitAccumTexture &&
      this.oitWidth === w &&
      this.oitHeight === h &&
      this.oitSampleCount === sampleCount
    )
      return
    if (this.oitAccumTexture) rhi.destroyTexture(this.oitAccumTexture)
    if (this.oitRevealageTexture) rhi.destroyTexture(this.oitRevealageTexture)
    if (this.offscreenExtrudeDepth) rhi.destroyTexture(this.offscreenExtrudeDepth)
    // OIT render targets — sampleCount matches the opaque pass so both can
    // share the same depth attachment. Without that sharing the OIT pass
    // had no depth → translucent buildings didn't occlude behind opaque
    // foreground walls. Compose pass resolves the MSAA samples in-shader.
    this.oitAccumTexture = rhi.createTexture({
      width: w,
      height: h,
      format: OIT_ACCUM_FORMAT,
      sampleCount,
      usage: ['render', 'sample'],
      label: 'oit-accum',
    })
    this.oitRevealageTexture = rhi.createTexture({
      width: w,
      height: h,
      format: OIT_REVEALAGE_FORMAT,
      sampleCount,
      usage: ['render', 'sample'],
      label: 'oit-revealage',
    })
    // Fresh depth for the two-pass offscreen extrude pass; kept for the
    // future OIT opt-in path (unread today).
    this.offscreenExtrudeDepth = rhi.createTexture({
      width: w,
      height: h,
      format: 'depth24plus-stencil8',
      sampleCount,
      usage: ['render'],
      label: 'offscreen-extrude-depth',
    })
    this.oitWidth = w
    this.oitHeight = h
    this.oitSampleCount = sampleCount
  }
}
