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

import { OIT_ACCUM_FORMAT, OIT_REVEALAGE_FORMAT, HEATMAP_DENSITY_FORMAT } from '../gpu/gpu-shared'
import type { GPUContext } from '../gpu/gpu'

/** Result of `RenderTargets.ensure` — the per-frame colour-attachment
 *  decision that depends on `sampleCount` / `debugOverdraw`. Identical to
 *  the locals (`useResolve`, `colorView`) the inline block computed. */
export interface EnsureResult {
  /** `sampleCount > 1` — whether passes resolve MSAA to the swapchain. */
  useResolve: boolean
  /** The colour attachment opaque/translucent passes draw into: the
   *  overdraw accumulator in `?debug=overdraw`, the MSAA texture view when
   *  `useResolve`, else `screenView` directly. */
  colorView: GPUTextureView
}

/** Owns the GPU render-target textures + recreate-on-resize lifecycle. The
 *  textures stay package-internal (read by RenderLoop + the pick path); this
 *  class is the single owner. */
export class RenderTargets {
  /** Stencil buffer for tile overlap masking. */
  stencilTexture: GPUTexture | null = null
  /** MSAA 4x render target (only allocated when sampleCount > 1). */
  msaaTexture: GPUTexture | null = null
  /** Weighted-Blended OIT accum target (rgba16float). Lazily allocated by
   *  `ensureOit()` ONLY when the scene has OIT-extrude content (default
   *  styles keep `isOitExtrude=false`, so the default path allocates none of
   *  the ~10 B/px these two targets cost). Mirrors `ensureHeatmap()`. */
  oitAccumTexture: GPUTexture | null = null
  /** Weighted-Blended OIT revealage target (r16float). Lazy — see above. */
  oitRevealageTexture: GPUTexture | null = null
  /** Fresh depth for the two-pass offscreen extrude pass. Lazy (allocated
   *  alongside the OIT targets in `ensureOit()`) — kept for the future OIT
   *  opt-in path; unread on the default path so allocating it eagerly was
   *  pure waste. */
  offscreenExtrudeDepth: GPUTexture | null = null
  /** `?debug=overdraw` r16float accumulator. */
  overdrawAccumTexture: GPUTexture | null = null
  /** Pick (GPU hover/click) RG32Uint single-sample colour attachment. */
  pickTexture: GPUTexture | null = null

  // ── Cached texture views ──
  // A GPUTexture.createView() with no args returns a fresh default view each
  // call; the passes used to mint one EVERY frame for stencil/pick/oit/msaa/
  // overdraw (4–8 allocations/frame). The backing textures only change on
  // resize, so the view is cached at (re)creation and the passes read it.
  // The swapchain view stays per-frame (a fresh getCurrentTexture each
  // acquire) and is never cached here.
  /** Cached view of `stencilTexture`. */
  stencilView: GPUTextureView | null = null
  /** Cached view of `pickTexture` (null when picking disabled). */
  pickView: GPUTextureView | null = null
  /** Cached view of `msaaTexture` (null when sampleCount === 1). */
  msaaView: GPUTextureView | null = null
  /** Cached view of `overdrawAccumTexture` (null unless `?debug=overdraw`). */
  overdrawView: GPUTextureView | null = null
  /** Cached view of `oitAccumTexture` (null until `ensureOit`). */
  oitAccumView: GPUTextureView | null = null
  /** Cached view of `oitRevealageTexture` (null until `ensureOit`). */
  oitRevealageView: GPUTextureView | null = null
  /** Cached view of `heatmapAccumTexture` (null until `ensureHeatmap`). */
  heatmapAccumView: GPUTextureView | null = null
  /** Cached view of `heatmapBlurTexture` (null until `ensureHeatmap`). */
  heatmapBlurView: GPUTextureView | null = null
  /** Heatmap density accumulation target (r16float, single-sample). Lazily
   *  allocated by `ensureHeatmap()` ONLY when a heatmap layer is present, so
   *  a style with no heatmap allocates nothing here (byte-identical default).
   *  Mirrors overdrawAccumTexture's lazy r16float pattern. */
  heatmapAccumTexture: GPUTexture | null = null
  /** Heatmap blur ping-pong target (r16float, single-sample). The separable
   *  Gaussian writes accum→blur (horizontal) then blur→accum (vertical), so
   *  the final blurred density lands back in heatmapAccumTexture. */
  heatmapBlurTexture: GPUTexture | null = null
  /** Size the textures were last allocated at (recreate gate). */
  msaaWidth = 0
  msaaHeight = 0
  /** Size the heatmap density textures were last allocated at — a separate
   *  tracker so the heatmap targets resize independently of the main MSAA
   *  block (they are never allocated in the default no-heatmap path). */
  private heatmapWidth = 0
  private heatmapHeight = 0
  /** Size + sample count the OIT targets were last allocated at — a separate
   *  tracker so the lazily-allocated OIT block resizes independently of the
   *  main MSAA block and recreates when the sample count changes. */
  private oitWidth = 0
  private oitHeight = 0
  private oitSampleCount = 0

  private readonly getCtx: () => GPUContext

  constructor(getCtx: () => GPUContext) {
    this.getCtx = getCtx
  }

  /** Force the next `ensure()` to reallocate even when w/h are unchanged
   *  (used by setQuality after an msaa/picking sampleCount change). Mirrors
   *  the old `host.msaaWidth = 0; host.msaaHeight = 0`. */
  invalidate(): void {
    this.msaaWidth = 0
    this.msaaHeight = 0
  }

  /** (Re)allocate the render-target textures when missing or resized, then
   *  return the per-frame colorView decision. VERBATIM port of the inline
   *  MSAA/stencil management block + colorView choice: same formats, usages,
   *  destroy-old order, MSAA-dims tracking, and recreate-on-resize gate. */
  ensure(
    w: number,
    h: number,
    sampleCount: number,
    pickEnabled: boolean,
    debugOverdraw: boolean,
    screenView: GPUTextureView,
  ): EnsureResult {
    const { device, format } = this.getCtx()
    const sc = sampleCount
    const useResolve = sc > 1
    if (!this.stencilTexture || this.msaaWidth !== w || this.msaaHeight !== h) {
      this.msaaTexture?.destroy()
      this.stencilTexture?.destroy()
      this.pickTexture?.destroy()
      this.overdrawAccumTexture?.destroy()
      this.overdrawAccumTexture = null
      this.overdrawView = null
      // Allocate the MSAA color attachment ONLY when MSAA is on. When
      // sc === 1 we render straight to the swapchain (no resolveTarget)
      // and the MSAA texture would just waste w×h×4 bytes per frame.
      this.msaaTexture = useResolve
        ? device.createTexture({
            size: { width: w, height: h },
            format,
            sampleCount: sc,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          })
        : null
      this.msaaView = this.msaaTexture?.createView() ?? null
      this.stencilTexture = device.createTexture({
        size: { width: w, height: h },
        format: 'depth24plus-stencil8',
        sampleCount: sc,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
      this.stencilView = this.stencilTexture.createView()
      // Pick RT: RG32Uint, single-sample. `?picking=1` forces SAMPLE_COUNT
      // to 1 globally (see quality.ts) so sc === 1 here whenever PICK is
      // true — the pick attachment and color attachment share sample count
      // as WebGPU requires.
      this.pickTexture = pickEnabled
        ? device.createTexture({
            size: { width: w, height: h },
            format: 'rg32uint',
            sampleCount: 1,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          })
        : null
      this.pickView = this.pickTexture?.createView() ?? null
      // The OIT + offscreen-extrude targets are NOT allocated here — they
      // move to the lazy `ensureOit()` (gated on scene OIT content), the
      // same way the heatmap targets gate on `scene.hasHeatmap`. On a
      // resize the stale OIT targets are size-mismatched; the next
      // `ensureOit()` recreates them via its own tracker.
      if (debugOverdraw) {
        // r16float lets per-pixel additive accumulation grow well
        // past the [0, 1] swapchain range. MSAA forced to 1× in
        // quality.ts when debug=overdraw, so sampleCount=1 here.
        this.overdrawAccumTexture = device.createTexture({
          size: { width: w, height: h },
          format: 'r16float',
          sampleCount: 1,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          label: 'overdraw-accum',
        })
        this.overdrawView = this.overdrawAccumTexture.createView()
      }
      this.msaaWidth = w
      this.msaaHeight = h
    }

    // When SAMPLE_COUNT === 1 (mobile / no MSAA), render DIRECTLY to the
    // swapchain texture and never set a resolveTarget — single-sample
    // attachments cannot have a resolve target per WebGPU spec.
    //
    // `?debug=overdraw` reroutes every opaque/translucent pass into the
    // r16float accumulator instead. A trailing compose pass at the end
    // of the frame samples the accumulator and writes the colormap to
    // the swapchain. Translucent/OIT paths still run — their debug
    // pipeline mirrors emit into the same accumulator with additive
    // blend, so the heatmap counts every contributing draw.
    const colorView = debugOverdraw
      ? this.overdrawView!
      : (useResolve ? this.msaaView! : screenView)

    return { useResolve, colorView }
  }

  /** Lazily (re)allocate the two heatmap density targets (accum + blur) at
   *  canvas size. Called from the render loop ONLY when `scene.hasHeatmap` —
   *  a style with no heatmap layer never invokes this, so the default render
   *  path allocates nothing (byte-identical). Both targets are r16float
   *  single-sample RENDER_ATTACHMENT | TEXTURE_BINDING (the accum pass draws
   *  splats into accum; the blur passes ping-pong between them; the compose
   *  pass samples accum). Recreates on resize via the dedicated size tracker
   *  so it never disturbs the MSAA block's gate. No per-frame allocation. */
  ensureHeatmap(w: number, h: number): void {
    if (this.heatmapAccumTexture && this.heatmapWidth === w && this.heatmapHeight === h) return
    const { device } = this.getCtx()
    this.heatmapAccumTexture?.destroy()
    this.heatmapBlurTexture?.destroy()
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    this.heatmapAccumTexture = device.createTexture({
      size: { width: w, height: h },
      format: HEATMAP_DENSITY_FORMAT,
      sampleCount: 1,
      usage,
      label: 'heatmap-accum',
    })
    this.heatmapBlurTexture = device.createTexture({
      size: { width: w, height: h },
      format: HEATMAP_DENSITY_FORMAT,
      sampleCount: 1,
      usage,
      label: 'heatmap-blur',
    })
    this.heatmapAccumView = this.heatmapAccumTexture.createView()
    this.heatmapBlurView = this.heatmapBlurTexture.createView()
    this.heatmapWidth = w
    this.heatmapHeight = h
  }

  /** Lazily (re)allocate the OIT targets (accum + revealage + offscreen-
   *  extrude depth) at canvas size + sample count. Called from the OIT pass
   *  ONLY when `scene.hasOit` — the default style keeps `isOitExtrude=false`
   *  so this never fires and the ~10 B/px the accum + revealage cost (plus
   *  the extrude depth) is never allocated. `sampleCount` matches the opaque
   *  pass so the OIT fill can share the opaque depth attachment. Recreates on
   *  resize or sample-count change via the dedicated tracker. */
  ensureOit(w: number, h: number, sampleCount: number): void {
    if (this.oitAccumTexture
      && this.oitWidth === w && this.oitHeight === h && this.oitSampleCount === sampleCount) return
    const { device } = this.getCtx()
    this.oitAccumTexture?.destroy()
    this.oitRevealageTexture?.destroy()
    this.offscreenExtrudeDepth?.destroy()
    // OIT render targets — sampleCount matches the opaque pass so both can
    // share the same depth attachment. Without that sharing the OIT pass
    // had no depth → translucent buildings didn't occlude behind opaque
    // foreground walls. Compose pass resolves the MSAA samples in-shader.
    this.oitAccumTexture = device.createTexture({
      size: { width: w, height: h },
      format: OIT_ACCUM_FORMAT,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'oit-accum',
    })
    this.oitRevealageTexture = device.createTexture({
      size: { width: w, height: h },
      format: OIT_REVEALAGE_FORMAT,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'oit-revealage',
    })
    // Fresh depth for the two-pass offscreen extrude pass; kept for the
    // future OIT opt-in path (unread today).
    this.offscreenExtrudeDepth = device.createTexture({
      size: { width: w, height: h },
      format: 'depth24plus-stencil8',
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      label: 'offscreen-extrude-depth',
    })
    this.oitAccumView = this.oitAccumTexture.createView()
    this.oitRevealageView = this.oitRevealageTexture.createView()
    this.oitWidth = w
    this.oitHeight = h
    this.oitSampleCount = sampleCount
  }

  /** Release the heatmap density targets (destroy + null). Called from the
   *  map's destroy() path. Safe to call when nothing was allocated. */
  destroyHeatmap(): void {
    this.heatmapAccumTexture?.destroy()
    this.heatmapBlurTexture?.destroy()
    this.heatmapAccumTexture = null
    this.heatmapBlurTexture = null
    this.heatmapAccumView = null
    this.heatmapBlurView = null
    this.heatmapWidth = 0
    this.heatmapHeight = 0
  }
}
