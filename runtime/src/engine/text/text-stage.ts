// ═══════════════════════════════════════════════════════════════════
// Text Stage (Batch 1c-8b)
// ═══════════════════════════════════════════════════════════════════
//
// Single-call orchestration over the four text subsystems:
//   - GlyphAtlasHost   (slot LRU + rasterise dispatch)
//   - GlyphAtlasGPU    (R8 texture + writeTexture loop)
//   - TextRenderer     (WGSL pipeline + vertex gen)
//   - resolveText      (TextValue + props → string)
//
// MapRenderer/VTR integration is a thin call: collect labels per
// frame via `addLabel(...)`, then `render(pass, viewport)`. The
// stage handles everything else (ensureString, atlas flush, draw
// list, color resolution from LabelDef).
//
// Coordinate frame: caller supplies SCREEN PIXELS for the anchor.
// The stage never touches projection — keeping that out of here
// means the same stage works for both lat/lon-anchored map labels
// AND screen-space overlays (HUD, scale bar).

import type { LabelDef, TextValue } from '@xgis/compiler'
import { resolveText, type FeatureProps } from './text-resolver'
import {
  GlyphAtlasHost, type GlyphAtlasHostOptions,
} from './sdf/glyph-atlas-host'
import { GlyphAtlasGPU } from './sdf/glyph-atlas-gpu'
import { createRasterizer, createMetricsRasterizer, type GlyphRasterizer } from './sdf/glyph-rasterizer'
import { GlyphPbfCache } from './sdf/pbf/glyph-pbf-cache'
import { bumpAlloc } from '../__profile__/alloc-counter'
import { FrameArena } from '../gpu/frame-arena'
import { InlineGlyphProvider } from './sdf/pbf/inline-glyph-provider'
import type { GlyphProvider } from './sdf/pbf/glyph-provider'
import { PbfRasterizer } from './sdf/pbf-rasterizer'
import { TextRenderer, type TextDraw } from './text-renderer'
import { greedyPlaceBboxes, type CollisionItem } from './text-collision'
import {
  applyTextTransform, stripCurveLineExtraScripts,
  evaluateVariableOffsetEm, variableAnchorOffsetEm,
  resolveTypography,
  layoutCacheKey, textKeyFor, layoutCacheEntryValid,
  mlVerticalLayout, composeFontKey,
  ONE_EM, SHAPING_DEFAULT_OFFSET, CJK_FALLBACK_CHAIN,
  type LabelAnchor,
} from './text-stage-helpers'
import type {
  TextStageOptions, PendingLabel, PendingLineLabel,
} from './text-stage-types'
import {
  wrapWithKnuthPlass, hasCjkIdeograph, CJK_MIN_DISPLAY_PX,
} from './text-wrap'
import { TextStageDiagnostics } from './text-stage-diagnostics'
// iter-265 — sub-phase drill inside prepare(). encoder.stage-prepare
// shows 1.31 ms/frame in iter-263 budget but we don't know which
// inner phase dominates (point shape vs curved line layout vs
// collision vs emit). Sub-marks let the perf harness identify the
// hottest sub-phase to attack next.
import { markStart as perfMarkStart, markEnd as perfMarkEnd } from '../__profile__/perf-marks'

// Re-export the previously-`export`ed types so the public surface of
// this module stays byte-identical after the text-stage-types.ts split.
export type { MlVerticalLayout, TextStageOptions } from './text-stage-types'
// Re-export the pure typography helper (moved to text-stage-helpers.ts)
// so existing `import { resolveTypography } from './text-stage'` works.
export { resolveTypography } from './text-stage-helpers'
// Re-export the test seam for the Knuth-Plass wrap engine (moved to
// text-wrap.ts) so existing `import { wrapForTesting } from './text-stage'`
// in text-wrap.test.ts / text-layout-edge.test.ts /
// bilingual-label-placement-repro.test.ts stays byte-identical.
export { wrapForTesting } from './text-wrap'
// Re-export the pure shaping helpers (moved to text-stage-helpers.ts)
// so existing test imports from './text-stage' stay byte-identical
// (layout-cache-entry-valid.test.ts, text-vertical.test.ts,
// text-layout-edge.test.ts, text-stage.test.ts,
// bilingual-label-placement-repro.test.ts).
export {
  layoutCacheEntryValid, mlVerticalLayout, verticalLayoutForTesting,
  composeFontKey,
} from './text-stage-helpers'

// Slot must fit (rasterFontSize + 2*sdfRadius). PBF arrives at 24 px
// native (MapLibre's ONE_EM). Setting rasterFontSize to match means
// PBF→atlas is a 1:1 byte copy with no bilinear resample — every
// PBF-sourced glyph keeps the upstream tile server's sub-pixel SDF
// precision exactly. The byte rescale in pbf-to-slot.ts becomes a
// no-op at scale=1 (`192 + (b-192) * 1.0 == b`), eliminating the
// resampling blur that softened OFM Bright country labels relative
// to MapLibre.
//
// Canvas2D fallback still works at 24 px raster — it's the cold-
// frame fallback that disappears after the first PBF range lands,
// so its slightly lower stroke fidelity is invisible in steady
// state. (Earlier code raised this to 32 px specifically for the
// Hangul/Han Canvas2D path, but the user-visible labels go through
// PBF on every supported style; the trade-off swung the wrong way.)
//
// pageSize 2304 = 36 slots/side at slotSize 64 → 1296 slots per
// page. Multi-page atlases handle CJK-heavy maps via the renderer's
// per-page bind groups; no change to that path.
//
// defaultFont chains common CJK fallbacks AFTER sans-serif so an
// engine-level label without a Mapbox font stack still reads
// Hangul/Han correctly on every host OS we ship on (macOS / Win /
// Linux). Per-label font stacks coming from Mapbox styles get the
// same fallback chain appended in composeFontKey. CJK_FALLBACK_CHAIN
// now lives in text-stage-helpers.ts alongside composeFontKey.
const DEFAULTS: Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography' | 'dpr' | 'onResourceLanded'>> = {
  slotSize: 64,
  // iter-272 — bump atlas slots 1296 → 4096 (~3.2× headroom).
  // User-reported bilingual label corruption on OFM Bright dense
  // scenes (Seoul z=11) where atlas overflow cycles within the
  // iter-268 preloadString pass, breaking the "all admissions
  // complete before shape work" invariant. Dense bilingual scenes
  // (Latin + Hangul ~300 syllables + CJK + numbers + punctuation ×
  // multiple font weights) exceed 1296. 4096² R8 = 16 MB (was 5.3 MB).
  pageSize: 4096,
  rasterFontSize: 24,
  sdfRadius: 8,
  defaultFont: CJK_FALLBACK_CHAIN,
}

export class TextStage {
  readonly host: GlyphAtlasHost
  readonly gpu: GlyphAtlasGPU
  readonly renderer: TextRenderer
  readonly opts: Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography' | 'dpr' | 'onResourceLanded'>>
  /** The PBF rasterizer when this stage was built with PBF/inline/
   *  custom-provider config; null when no PBF chain is active.
   *  Exposed so `addGlyphProvider` can extend the chain after the
   *  stage is up. */
  private readonly pbfRasterizer: PbfRasterizer | null
  /** Per-font typography table — see TextStageOptions.fontTypography.
   *  Null when no overrides were configured (default identity behaviour). */
  private readonly fontTypography: TextStageOptions['fontTypography'] | null
  private readonly pending: PendingLabel[] = []
  /** S16 prepare-skip guard: false when the last prepare() dropped any label
   *  because its glyphs hadn't landed yet (an async glyph range still in
   *  flight). The label pass must NOT skip prepare while this is false, or a
   *  label awaiting its glyphs would stay dropped until the camera moves. */
  private _lastPrepareFullyResolved = false
  private readonly pendingLine: PendingLineLabel[] = []
  /** iter-241 (Plan AAA B.2) — per-frame scratch arena for typed-array
   *  allocations that today fire per-label-per-frame inside `prepare()`.
   *  iter-240 interactive profile pinned `advances.Array` at 12,573
   *  allocations in a 3 s zoom+pan window — 54 % of the profiled
   *  total. Migrating to FrameArena turns those into watermark
   *  bumps in a single ArrayBuffer; allocation rate stabilises at
   *  the per-session peak.
   *
   *  Sub-views must NOT outlive the next `beginFrame()` call —
   *  watermark reset invalidates them. Confined to the
   *  prepare()-then-render-once pass, which completes within one
   *  synchronous frame. */
  // iter-251 — initial 64 KB overflowed on dense scene (text-stage
  // advances + baselineY + glyphOffsets point + curved sums past
  // 65 KB on Bright z=10 zoom transitions). Bumped initial to
  // 256 KB; auto-grow handles further peaks via the GROW_TRIGGER
  // logic in FrameArena.beginFrame.
  private readonly _frameArena = new FrameArena(256 * 1024)
  /** iter-241 — call at the start of each frame (map.ts renderFrame).
   *  Resets the arena watermark; capacity grows automatically. */
  beginFrame(): void {
    this._frameArena.beginFrame()
  }
  /** Bounded label-pipeline observability (dispatch texts, z0-halo
   *  norm probe, glyph-placement dump, submitted/drawn counters, trace
   *  records). Diagnostics-only: zero influence on draws. The VERBS
   *  stay at the call sites in addLabel / addCurvedLineLabel /
   *  prepare(); TextStage keeps every public getter/setter as a thin
   *  forwarder so external/test signatures stay unchanged. */
  private readonly _diag = new TextStageDiagnostics()
  /** Iter 112: pair-keys of labels REJECTED by the collision pass.
   *  IconStage reads this set in its own prepare() to drop matching
   *  icons — MapLibre-style "text+icon as one symbol" sync without a
   *  full paired-symbol collision queue. Cleared every prepare(). */
  private readonly droppedPairKeys: Set<string> = new Set()
  /** iter 167 — across-frame glyph-string cache (#10 Phase A first
   *  slice). `host.ensureString` per-character atlas-slot lookup
   *  dominates drag CPU (iter-161 profile: ensure 21.5% +
   *  ensureString 7.1% = 28.6%). For the SAME (fontKey, text) the
   *  result is camera-independent; cache it across frames. Cap at
   *  4096 entries (well above any label-dense scene; OFM Bright
   *  Korea z=5 has ~5k addLabel calls but most share a tiny set of
   *  unique texts). Invalidated wholesale on atlas eviction (rare).
   *
   *  Key: FNV-1a hash of (fontKey, text codepoints) — same shape as
   *  pretextCacheKey. Value: GlyphInfo[] (one per codepoint, same
   *  array shape host.ensureString would return). */
  private readonly _glyphsByTextCache = new Map<number, import('./sdf/glyph-atlas-host').GlyphInfo[]>()
  /** iter 168 — Phase A slice 2: across-frame layout cache.
   *  Caches the per-anchor camera-independent layout output (dx, dy,
   *  glyphOffsets, totalAdvance, blockTop, blockBottom, haloGeom,
   *  letterSpacingPx, rotateRad) for the SINGLE-ANCHOR-STATIC case
   *  (no variable anchors / no radialOffset / single candidate / no
   *  rotate). Variable-mode labels skip the cache (their layout
   *  depends on anchor-specific offset evaluation that is more
   *  intricate to fingerprint safely). Per frame on hit:
   *  drawX/Y = p.anchorX/Y + cached.dx/dy, bbox = drawX/Y +
   *  cached.bbox-offsets, color = per-frame p.def.color, halo color
   *  = per-frame p.def.halo.color (only halo GEOMETRY is cached). */
  private readonly _layoutCache = new Map<number, {
    dx: number; dy: number; totalAdvance: number
    blockTop: number; blockBottom: number; padding: number
    glyphOffsets: Float32Array
    glyphs: import('./sdf/glyph-atlas-host').GlyphInfo[]
    /** iter-190 — atlas generation at cache write. On read, compare
     *  with host.getGeneration(); mismatch → glyphs[] slot references
     *  may point at reassigned codepoints (iter-175 corruption root),
     *  so treat as cache miss. */
    generation: number
    /** Audit ④ B1 — exact source identity (`fontKey\0text`) at write.
     *  On read, a `_layoutKey` hash collision is rejected by comparing
     *  this against the requesting label's srcKey (see layoutCacheEntryValid). */
    srcKey: string
    haloGeom?: { width: number; blur?: number }
    sizePx: number; letterSpacingPx: number; rotateRad?: number
  }>()
  private static readonly LAYOUT_CACHE_MAX = 4096
  // iter-266 — layout cache hit-rate counter. The iter-261 L.1.1
  // probe at the OUTER label-dispatch loop (map.ts sig cache)
  // recorded 4.9 % hit-rate on zoom+pan, but the inner layout
  // cache here is keyed on content alone (textKeyFor + sizePx +
  // maxWidthPx + ... — no camera term), so its hit-rate should be
  // dramatically higher and reveal where the real Phase L.1 fix
  // is. Read via TextStage.getLayoutCacheStats() — wired into
  // map.ts global probe in the same iter for harness access.
  private _layoutCacheHits = 0
  private _layoutCacheMisses = 0
  getLayoutCacheStats(): { hits: number; misses: number; hitRate: number; entries: number } {
    const total = this._layoutCacheHits + this._layoutCacheMisses
    return {
      hits: this._layoutCacheHits,
      misses: this._layoutCacheMisses,
      hitRate: total > 0 ? this._layoutCacheHits / total : 0,
      entries: this._layoutCache.size,
    }
  }
  /** DPR applied to LabelDef.size (and offset/halo/maxWidth) at
   *  prepare() time. Anchors arrive already in physical pixels
   *  (map.ts projects against canvas.width/height) but `size` etc.
   *  come from xgis source in CSS-px convention — multiplying by
   *  DPR keeps text the right visual size on hidpi displays. */
  private dpr: number = 1

  constructor(
    device: GPUDevice,
    presentationFormat: GPUTextureFormat,
    options: TextStageOptions = {},
    sampleCount: number = 1,
  ) {
    this.opts = { ...DEFAULTS, ...options } as Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography' | 'dpr' | 'onResourceLanded'>>
    // Iter 116: rasterFontSize + sdfRadius are now DPR-invariant —
    // they match MapLibre's TinySDF defaults (fontSize=24, radius=8,
    // textureScale=1) and the PBF glyph server's native 24-px raster.
    // Display-size scaling happens at draw time via the shader's
    // sizePx / rasterFontSize factor, so glyph fidelity does NOT
    // depend on the host DPR.
    //
    // Pre-iter-116 multiplied both knobs by dpr (capped at 1.6 to fit
    // the slot). Justification was "fewer GPU upscales on hidpi", but
    // the trade-off conflicted with iter 114 / iter 115 SDF-encoding
    // parity work: a DPR-scaled local raster produced byte SDFs at a
    // DIFFERENT pixel-per-unit ratio than the PBF 24-px reference,
    // forcing the halo math to compensate per-source. With both
    // sources locked to the MapLibre TinySDF defaults, the shader's
    // 2.52/font_size_px AA half-width and haloK=3 are exact across
    // PBF and Canvas2D paths.
    //
    // Side effect: Canvas2D-rasterised glyphs (Hangul / icons / any
    // font absent from the PBF server) cost ~dpr² fewer GPU bytes
    // per slot, slightly reducing atlas memory on hidpi displays.
    // Rasterizer selection:
    //   1. explicit `rasterizer` override     → use as-is
    //   2. ANY of {glyphsUrl, inlineGlyphs,
    //      glyphProviders} supplied           → wrap Canvas2D with a
    //                                           PbfRasterizer chain
    //   3. neither                            → plain Canvas2D / Mock
    //                                           (existing path, byte-
    //                                           identical to pre-PBF)
    //
    // Chain order (cheapest-source-first):
    //   [InlineGlyphProvider, ...glyphProviders, GlyphPbfCache]
    //
    // The PbfRasterizer's `onLanded` forward-references `this.pbfRas`
    // via the constructor closure — only invoked async, after the
    // host is assigned a few lines below, so the temporal coupling
    // is sound.
    let rasterizer: GlyphRasterizer
    let pbfRas: PbfRasterizer | null = null
    if (options.rasterizer) {
      rasterizer = options.rasterizer
    } else if (options.glyphsUrl || options.inlineGlyphs || options.glyphProviders) {
      // PBF environment: glyphs arrive async from the network in
      // 50-200 ms typical. The sync fallback fires PER GLYPH on cold
      // frames (rapid pan / zoom in-out) — the full Canvas2D path
      // (fillText + getImageData + computeSDF) burns ~8 ms / glyph,
      // accumulating to 100+ ms freezes on dense label scenes.
      // Substitute a metrics-only fast path: measureText keeps the
      // layout correct, SDF is zero (glyph invisible) for the brief
      // window before the PBF range arrives and atlas.invalidate
      // triggers an upgrade to the real SDF on the next frame. The
      // full Canvas2D path is wired as the last-resort fallback for
      // codepoints PBF can't deliver (returns zero advance from
      // measureText → upgrade to full).
      const fullFallback = createRasterizer()
      const fallback = createMetricsRasterizer(fullFallback)
      const providers: GlyphProvider[] = []
      if (options.inlineGlyphs) providers.push(new InlineGlyphProvider(options.inlineGlyphs))
      if (options.glyphProviders) providers.push(...options.glyphProviders)
      if (options.glyphsUrl) providers.push(new GlyphPbfCache({ glyphsUrl: options.glyphsUrl }))
      pbfRas = new PbfRasterizer({
        fallback, providers,
        onLanded: (fontKey, codepoint) => {
          // Invalidate the atlas slot (upgrade zero-SDF → real SDF next
          // frame) AND ring the bell on the owning map (Audit ① B1): the
          // S16 label-collision skip would otherwise keep replaying the
          // stale glyph until the camera moves, because the dispatch
          // signature is unchanged by a background resource landing.
          this.host.invalidate(fontKey, codepoint)
          options.onResourceLanded?.()
        },
      })
      rasterizer = pbfRas
    } else {
      rasterizer = createRasterizer()
    }
    this.pbfRasterizer = pbfRas
    this.fontTypography = options.fontTypography ?? null
    const hostOpts: GlyphAtlasHostOptions = {
      fontSize: this.opts.rasterFontSize,
      sdfRadius: this.opts.sdfRadius,
    }
    this.host = new GlyphAtlasHost(
      { slotSize: this.opts.slotSize, pageSize: this.opts.pageSize },
      rasterizer,
      hostOpts,
    )
    this.gpu = new GlyphAtlasGPU(device, this.host, { pageSize: this.opts.pageSize })
    this.renderer = new TextRenderer(device, this.gpu, presentationFormat, sampleCount)
  }

  /** Pre-warm the atlas with a glyph set. Run once at engine init
   *  to bake digits + punctuation + Latin alphabet so the first
   *  frame doesn't pay rasterisation cost on cold paths. */
  prewarm(codepoints: Iterable<number>, fontKey?: string): void {
    this.host.prewarm(fontKey ?? this.opts.defaultFont, codepoints)
  }

  /** Append a glyph provider to the PBF chain. No-op when this stage
   *  was built without any PBF/inline/custom-provider config (no
   *  PbfRasterizer to extend). The provider is consulted from the
   *  next `ensure()` onward — already-cached atlas slots keep their
   *  current bytes until invalidated. Used by `XGISMap.addGlyph
   *  Provider` for runtime composition. */
  addGlyphProvider(provider: GlyphProvider): void {
    if (!this.pbfRasterizer) return
    this.pbfRasterizer.addProvider(provider)
    // Re-raster all: a runtime-added provider may supply glyphs already shaped as
    // the fallback; the generation bump makes the string caches miss next prepare.
    this.host.invalidateAll()
  }

  /** Re-raster every glyph — e.g. after a WOFF FontFace lands so glyphs drawn
   *  with the Canvas2D system fallback upgrade. Bumps the atlas generation. */
  invalidateAllGlyphs(): void {
    this.host.invalidateAll()
  }

  /** Set the device pixel ratio for the current frame. Call before
   *  prepare(). Sizes/offsets in LabelDef are CSS-px convention;
   *  multiplying by DPR matches the physical-pixel anchor space. */
  setDpr(dpr: number): void {
    this.dpr = dpr > 0 ? dpr : 1
  }

  /** Resolve per-font typography overrides for the given fontKey. */
  private typographyFor(fontKey: string): { letterSpacingEm: number; lineHeightScale: number } {
    return resolveTypography(fontKey, this.fontTypography)
  }

  /** Camera zoom for zoom-dependent text-field expressions (Mapbox
   *  `text-field: ["step", ["zoom"], …]` / legacy stops shape).
   *  Forwarded into the evaluator's props bag under the
   *  CAMERA_ZOOM_KEY sigil so `step(zoom, …)` evaluates correctly.
   *  Call once per frame BEFORE addLabel / addCurvedLineLabel
   *  submissions. */
  setCameraZoom(zoom: number): void {
    this.cameraZoom = zoom
  }
  private cameraZoom: number | undefined

  /** Optional render-trace recorder. When non-null, every addLabel /
   *  addCurvedLineLabel call pushes a rich `TraceLabel` (text, colour,
   *  halo, font, placement, anchor) for downstream invariant tests.
   *  Distinct from the older `_debugHook`, which only carries the
   *  (text, x, y, kind) tuple — kept for back-compat with the
   *  `#labels-debug` URL flag. Both can be active simultaneously. */
  setTraceRecorder(recorder: import('../../diagnostics/render-trace').RenderTraceRecorder | null): void {
    this._traceRecorder = recorder
  }
  private _traceRecorder: import('../../diagnostics/render-trace').RenderTraceRecorder | null = null

  /** Optional per-call hook fired once per addLabel /
   *  addCurvedLineLabel submission BEFORE collision. The hook receives
   *  the final-rendered text string + the screen-pixel anchor + the
   *  kind ('point' vs 'curve'). Used by the playground's
   *  `#labels-debug` URL flag to attach a DOM overlay on mobile where
   *  console debugging isn't available. Hook is called once per
   *  submission — collision-dropped labels still trigger it (so the
   *  user can SEE which submissions are being made even if collision
   *  hides them visually). */
  setLabelDebugHook(hook: ((text: string, ax: number, ay: number, kind: 'point' | 'curve') => void) | undefined): void {
    this._debugHook = hook
  }
  private _debugHook?: (text: string, ax: number, ay: number, kind: 'point' | 'curve') => void

  /** Default prewarm set: '0'..'9', '.,:;-+°\'\"NSEW '. Covers
   *  cursor coord readouts, timestamps, distance/bearing labels. */
  prewarmGISDefaults(fontKey?: string): void {
    const set: number[] = []
    for (let c = 0x20; c <= 0x7E; c++) set.push(c)  // basic Latin
    set.push(0xB0)  // °
    this.prewarm(set, fontKey)
  }

  /** Queue a curved label that follows a screen-projected polyline.
   *  Each glyph is placed at a different sample point along the
   *  polyline with rotation matching the local tangent — the
   *  Mapbox `symbol-placement: line` look. Caller supplies the
   *  polyline in physical-pixel coordinates plus a centre offset
   *  (distance along the polyline where the label centres). When
   *  the resolved text is wider than the available polyline length,
   *  the label is silently skipped. */
  addCurvedLineLabel(
    value: TextValue,
    props: FeatureProps,
    polylineX: Float32Array,
    polylineY: Float32Array,
    centerOffsetPx: number,
    def: LabelDef,
    fontKey?: string,
    layerName?: string,
    pairKey?: string,
  ): void {
    const text = resolveText(value, props, this.cameraZoom)
    if (text.length === 0) return
    // stripCurveLineExtraScripts drops everything from the first LF
    // onwards — Mapbox bilingual labels render only the primary
    // script along curves (Latin\nNonLatin would otherwise lay both
    // scripts head-to-tail along the road).
    const transformed = stripCurveLineExtraScripts(applyTextTransform(text, def.transform))
    if (transformed.length === 0) return
    this._diag.recordDispatch(transformed)
    if (this._debugHook && polylineX.length > 0) {
      // Approximate the curve's anchor as its first vertex — enough
      // for the debug overlay to pin down a screen position. Mid-
      // point would require walking centerOffsetPx, which isn't
      // worth the cost for a debug-only path.
      this._debugHook(transformed, polylineX[0]!, polylineY[0]!, 'curve')
    }
    if (polylineX.length > 0) {
      this._diag.recordTrace(
        this._traceRecorder, 'curve', def, transformed,
        polylineX[0]!, polylineY[0]!, layerName,
      )
    }
    this.pendingLine.push({
      text: transformed,
      polylineX, polylineY, centerOffsetPx,
      def,
      fontKey: fontKey ?? composeFontKey(def, this.opts.defaultFont),
      pairKey,
    })
  }

  /** Queue one label for the current frame. Resolve text from a
   *  TextValue + feature props inline; caller already knows the
   *  feature's screen anchor (after projection). Empty resolved
   *  text is silently skipped. */
  /** iter-336 — glyph-atlas generation (host bumps on every slot
   *  eviction). Stable across a steady frame ⇒ no eviction ⇒ no
   *  glyph-slot aliasing possible. See XGISMap.getAtlasGeneration. */
  getAtlasGeneration(): number { return this.host.getGeneration() }

  /** Enable per-glyph offset capture for labels containing `substr`.
   *  Pass null to disable. Cleared + refilled each prepare(). */
  setLabelDumpFilter(substr: string | null): void { this._diag.setLabelDumpFilter(substr) }
  /** Last prepare()'s captured labels matching the dump filter, with
   *  each glyph's resolved (x,y) offset from the label anchor PLUS the
   *  per-glyph metrics + display fontSize + atlas slotSize the renderer
   *  uses to compute the final vertex y (y0 = anchorY + y -
   *  bearingY*(fontSize/rfs) - (slotSize - height)*(fontSize/rfs)/2).
   *  A correct label has uniform RENDERED y per line; a mixed-rfs glyph
   *  renders at the wrong height even when its offset y is correct. */
  getDumpedLabels(): ReadonlyArray<{
    text: string; anchorX: number; anchorY: number; fontSize: number; slotSize: number; curved: boolean
    glyphs: ReadonlyArray<{ cp: number; x: number; y: number; bearingY: number; height: number; rfs: number }>
  }> { return this._diag.getDumpedLabels() }

  /** Diagnostic: every resolved text string the stage has submitted
   *  since last clear (mirror of IconStage.getDispatchedIconNames).
   *  Iter 108 — added to localize the OFM Bright Texas highway-shield
   *  text-overlay no-render bug. */
  getDispatchedLabelTexts(): string[] { return this._diag.getDispatchedLabelTexts() }
  clearDispatchedLabelTexts(): void { this._diag.clearDispatchedLabelTexts() }
  /** iter-285 — last frame's submitted (raw addLabel) and drawn
   *  (post-collision) label counts. `submitted - drawn` measures
   *  collision-suppression pressure for the most recent prepare(). */
  getLastSubmittedLabelCount(): number { return this._diag.getLastSubmittedLabelCount() }
  getLastDrawnLabelCount(): number { return this._diag.getLastDrawnLabelCount() }
  /** iter 152 — drain the z0-halo probe capture (see haloDebug). */
  getHaloDebug(): ReadonlyArray<{
    text: string; fontSize: number; rasterFontSize: number
    haloWidth: number; haloWidthNorm: number
  }> { return this._diag.getHaloDebug() }
  clearHaloDebug(): void { this._diag.clearHaloDebug() }

  /** Iter 112: pair-keys of text labels REJECTED by the most recent
   *  prepare() collision pass. IconStage.prepare reads this to drop
   *  paired icons whose text was dropped. Set is cleared at the
   *  START of each prepare() so call order matters: IconStage must
   *  run AFTER TextStage. */
  getDroppedPairKeys(): ReadonlySet<string> { return this.droppedPairKeys }

  addLabel(
    value: TextValue,
    props: FeatureProps,
    anchorScreenX: number,
    anchorScreenY: number,
    def: LabelDef,
    fontKey?: string,
    layerName?: string,
    pairKey?: string,
  ): void {
    const text = resolveText(value, props, this.cameraZoom)
    if (text.length === 0) return
    const transformed = applyTextTransform(text, def.transform)
    // Iter 108 dispatch diagnostic — record post-resolve text BEFORE
    // collision. Mirror of IconStage.dispatchedIconNames.
    this._diag.recordDispatch(transformed)
    if (this._debugHook) {
      this._debugHook(transformed, anchorScreenX, anchorScreenY, 'point')
    }
    this._diag.recordTrace(
      this._traceRecorder, 'point', def, transformed,
      anchorScreenX, anchorScreenY, layerName,
    )
    this.pending.push({
      text: transformed,
      anchorX: anchorScreenX,
      anchorY: anchorScreenY,
      def,
      fontKey: fontKey ?? composeFontKey(def, this.opts.defaultFont),
      pairKey,
    })
  }

  /** Realize queued labels into atlas + GPU + draw list. Caller
   *  invokes this once per frame after all addLabel() calls and
   *  before encoding the render pass; render() then encodes the
   *  draws onto the supplied pass. */
  prepare(): void {
    // iter-285 — snapshot submitted count BEFORE collision pass.
    // pendingLine entries each may yield 1+ placements; counted as 1
    // per submission for a coarse but useful diagnostic.
    this._diag.setSubmittedCount(this.pending.length + this.pendingLine.length)
    if (this.pending.length === 0 && this.pendingLine.length === 0) {
      this.renderer.setDraws([])
      this._diag.setDrawnCount(0)
      this._lastPrepareFullyResolved = true // nothing to resolve
      return
    }
    // Phase 1: shape every label, compute its screen-space bbox, and
    // resolve the post-anchor draw position. Bbox is needed for the
    // greedy collision pass below.
    interface ShapedLabel {
      // One layout per candidate anchor. layouts[0] is the primary
      // (used by single-anchor labels); fallbacks come after for
      // text-variable-anchor.
      layouts: Array<{
        draw: TextDraw
        bbox: { minX: number; minY: number; maxX: number; maxY: number }
      }>
      allowOverlap: boolean
      ignorePlacement: boolean
      /** Mapbox `symbol-sort-key` — lower wins collisions. When
       *  undefined falls back to layer-order priority via the
       *  reverse iteration trick below. */
      sortKey?: number
      /** Iter 112 paired-symbol collision: pairKey of the paired icon
       *  for curved line shields. Carried on the shaped entry (not
       *  indexed back into pendingLine) because the line-loop below
       *  `continue`-skips unshapeable labels, so shaped[] is NOT 1:1
       *  with pendingLine[] indices. The drop loop reads it directly. */
      pairKey?: string
    }
    const shaped: ShapedLabel[] = []
    const dpr = this.dpr
    // iter-167 Phase A first slice — across-frame glyph-string cache.
    // Atlas evictions invalidate cached GlyphInfo[] (the slot the
    // entry references is reused for a different codepoint), so on
    // ANY eviction this frame, drop the whole cache before lookups.
    // host.consumeEvictions() has no other consumer in the current
    // codebase (grep verified iter-167), so draining here is safe;
    // the GPU upload wrapper observes consumeDirty separately.
    if (this.host.consumeEvictions().length > 0) {
      this._glyphsByTextCache.clear()
      // iter-168: layout cache entries reference GlyphInfo[] whose
      // slot.pxX/pxY would point to the wrong glyph after eviction.
      this._layoutCache.clear()
    }

    // iter-268 — atlas slot aliasing fix. PRE-LOAD every codepoint
    // needed by every pending label BEFORE any shaping loop builds a
    // GlyphInfo[] array that downstream code holds in `shaped[]`.
    //
    // Bug class (user-reported 2026-05-21 OFM Bright z=5 Korea):
    // "Pyongyang" rendering as "Pyongy시ng"; "South Korea" as
    // "South 민국ea". The exact same iter-175 corruption that motivated
    // the iter-167/168 cache revert AND the iter-190 generation
    // guard — but those fixes only catch the CROSS-FRAME and
    // CACHE-RE-LOOKUP cases. They do not catch the within-frame
    // path: label A calls ensureString → builds A_glyphs holding
    // slot refs → label B calls ensureString → B's ensure() evicts
    // one of A_glyphs' slots and reuses pxX/pxY for B's codepoint →
    // A_glyphs is still alive in `shaped[]`, the renderer reads
    // its (now stale) slot reference, and the wrong SDF is drawn.
    //
    // Fix: collect all admissions into the atlas in a dedicated
    // phase BEFORE any shaped[] entry exists. Any evictions trigger
    // BEFORE any live GlyphInfo[] reference is held. After this
    // loop, the atlas is stable for the rest of the frame; the
    // subsequent ensureString calls in the shape loops below find
    // every codepoint already in metrics + infoCache and do not
    // trigger further evictions.
    //
    // Assumes the atlas fits all unique codepoints in one frame
    // (true for OFM-class styles: ~50-300 labels × ~10 chars
    // ≪ atlas slot capacity). If the atlas is too small, eviction
    // cycles during preload would still leave some labels mis-
    // rendered — that's a separate "atlas size budget" issue and
    // doesn't apply at the user-reported zoom levels.
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!
      this.host.preloadString(p.fontKey, p.text)
    }
    for (let i = 0; i < this.pendingLine.length; i++) {
      const p = this.pendingLine[i]!
      this.host.preloadString(p.fontKey, p.text)
    }

    // iter-273 — atlas overflow guard. preloadString admits each
    // codepoint individually; when total unique codepoints across
    // all pending labels exceed atlas slot capacity, the LRU policy
    // evicts the earliest-admitted codepoints to make room for the
    // latest. The "atlas stable for the rest of the frame"
    // invariant iter-268 relied on no longer holds.
    //
    // Without this guard, the shape loop's ensureString returns
    // GlyphInfo[] arrays whose slot.pxX/pxY references point to
    // atlas pixels that get OVERWRITTEN by later labels' codepoints
    // before render reads them. The renderer reads the wrong SDF
    // bytes → the iter-175 "Pyongyang → Pyongy시ng" / "Se성남nam 시"
    // corruption class returns even with iter-268 preload + iter-272
    // atlas size bump (overflow scales with scene density).
    //
    // Fix: AFTER the preload loop completes (atlas is now in its
    // final state for this frame), verify EVERY pending label's
    // codepoints are STILL all resident. If any codepoint was
    // evicted (= the label overflowed), drop the label entirely
    // for this frame. Better to skip than to render corrupted text.
    //
    // The drop is in-place: zero out the entry's text so the shape
    // loop's ensureString call returns an empty array → shaped[]
    // gets an empty layout → collision drops it cleanly. Cleared
    // on next frame's reset().
    // Track whether EVERY label's glyphs were present this prepare. A drop
    // here means an async glyph range is still in flight; the S16 skip reads
    // _lastPrepareFullyResolved so the label pass keeps re-preparing (rather
    // than freezing a dropped label) until the range lands.
    let fullyResolved = true
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!
      if (!this.host.hasAllGlyphs(p.fontKey, p.text)) {
        p.text = ''  // overflow drop — label skipped this frame
        fullyResolved = false
      }
    }
    for (let i = 0; i < this.pendingLine.length; i++) {
      const p = this.pendingLine[i]!
      if (!this.host.hasAllGlyphs(p.fontKey, p.text)) {
        p.text = ''
        fullyResolved = false
      }
    }
    this._lastPrepareFullyResolved = fullyResolved

    // iter-265 — sub-phase drill. Point-label shaping loop covers
    // ensureString + advances FrameArena fill + Knuth-Plass wrap +
    // per-anchor candidates' vertical layout + per-glyph offsets +
    // bbox compute + cache hit/miss store. The single biggest chunk
    // of prepare() time when point labels dominate (countries, POI).
    perfMarkStart('stage-prepare.point-loop')
    for (const p of this.pending) {
      // iter-175 REVERT: the iter-167 glyphsByTextCache + iter-168
      // layoutCache caused intermittent label corruption (user
      // report 2026-05-20 OFM positron #7.54/36.227/128.513 —
      // 한글 라벨이 깨져서 보여, e.g. "대전광역시" rendering as
      // "광역" with missing/wrong chars). Root: cached GlyphInfo[]
      // entries reference atlas-slot OBJECTS which the atlas-state
      // reuses for different codepoints over the session. Even with
      // a per-iteration eviction drain (iter-175 attempt), the
      // shared-slot aliasing produced wrong glyphs across labels.
      // Phase A label cache shipped iter-167/168 disabled here
      // pending redesign (likely needs slot-generation indices on
      // GlyphInfo or a cache value that copies pxX/pxY rather than
      // referencing the live slot). #10 drag p95 -36% (slice 1) +
      // -4% (slice 2) gains lost; correctness > perf.
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      // CSS-px → physical-px. The atlas is in physical px (anchors
      // arrive projected to canvas.width/height) so every length
      // sourced from the LabelDef has to scale by DPR.
      // Floor CJK-bearing labels to a legible display size: a dense Han glyph
      // minified from the 24-px atlas to the ~9-px zoom-clamped low-zoom size
      // renders as a solid box. Latin-only labels keep their style size.
      const rawSizePx = p.def.size * dpr
      const sizePx = hasCjkIdeograph(p.text)
        ? Math.max(rawSizePx, CJK_MIN_DISPLAY_PX * dpr)
        : rawSizePx
      // letter-spacing in em units (Mapbox convention) — multiplies
      // the display font size to produce extra px between adjacent
      // glyphs. Per-font override (from fontTypography table) is ADDED
      // to the layer-level value so multi-font bundles can rebalance
      // intrinsic tracking differences without forking the style.
      const typo = this.typographyFor(p.fontKey)
      const letterSpacingPx = ((p.def.letterSpacing ?? 0) + typo.letterSpacingEm) * sizePx
      // Multiline layout: greedy word-break at maxWidth (em-units →
      // px). When unset, treat as Infinity = single line.
      const maxWidthPx = p.def.maxWidth !== undefined
        ? p.def.maxWidth * sizePx : Infinity
      const lineHeightEm = (p.def.lineHeight ?? 1.2) * typo.lineHeightScale
      const lineHeightPx = lineHeightEm * sizePx
      const justify = p.def.justify ?? 'center'

      // Per-glyph display advances (slot→px). Vertical placement does
      // NOT use ink metrics anymore — it follows MapLibre's constant
      // lineHeight-box model via `mlVerticalLayout` per candidate
      // anchor below.
      // iter-241 (Plan AAA B.2) — FrameArena-backed scratch instead
      // of `new Array(glyphs.length)`. iter-240 profile pinned this
      // site at 12,573 / 3 s on the interactive harness (top
      // allocator, 54 %). Sub-view valid through the synchronous
      // prepare() → render flow; the watermark resets next frame
      // (TextStage.beginFrame), invalidating this view but only
      // after the consumer (wrapWithKnuthPlass + downstream draw)
      // is done. Float32 precision matches the ~0.1 px tolerance of
      // PBF advance buckets — no observable rounding regression.
      bumpAlloc('text-stage.prepare.advances.FrameArena')
      const advances = this._frameArena.allocF32(glyphs.length)
      for (let gi = 0; gi < glyphs.length; gi++) {
        const g = glyphs[gi]!
        // Per-glyph slot→display scale: PBF runs are baked at 24 px,
        // local Hangul at the DPR-scaled raster — one bilingual label
        // mixes both, so the factor can't be label-wide.
        const scale = sizePx / (g.rasterFontSize ?? this.opts.rasterFontSize)
        advances[gi] = g.advanceWidth * scale
      }

      // Pretext handles the line-break decisions — Intl.Segmenter for
      // grapheme clusters (proper emoji ZWJ + combining marks),
      // streaming line-break with locale-aware break opportunities
      // around CJK/Hangul, soft hyphen support. We back-map its line
      // text to OUR glyph indices and recompute widths from our
      // SDF-rasterised advances so the renderer's per-glyph pen
      // positions stay consistent (the alternative — using pretext's
      // canvas-measured widths — would diverge from advanceWidth and
      // smear the bbox math).
      const lines = wrapWithKnuthPlass(
        glyphs, advances, p.fontKey, sizePx,
        letterSpacingPx, maxWidthPx,
      )
      // Total bounding box width = max line width.
      let totalAdvance = 0
      for (const ln of lines) if (ln.width > totalAdvance) totalAdvance = ln.width
      // Variable anchor (Mapbox `text-variable-anchor`): runtime
      // tries each candidate during collision and picks the first
      // non-overlapping one. Single-anchor labels always have one
      // candidate. The full draw + bbox is computed per candidate
      // here; the post-collision phase below picks the chosen one.
      // Mapbox variable placement. `text-variable-anchor-offset`
      // carries its own ordered anchor list (so it doubles as the
      // candidate set); otherwise `anchorCandidates` (text-variable-
      // anchor) drives it, falling back to the single static anchor.
      const vao = p.def.variableAnchorOffset
      const candidates: readonly LabelAnchor[] = vao
        ? vao.map(pair => pair[0])
        : (p.def.anchorCandidates && p.def.anchorCandidates.length > 0
            ? p.def.anchorCandidates
            : [p.def.anchor ?? 'center'])
      // MapLibre routes text-offset / text-radial-offset through the
      // per-anchor sign/axis rules ONLY for variable-placement labels.
      // A static single text-anchor keeps the plain offset add (no
      // baseline shift) — matching MapLibre's non-variable path.
      const variableMode = vao !== undefined
        || p.def.radialOffset !== undefined
        || (p.def.anchorCandidates !== undefined && p.def.anchorCandidates.length > 1)
      const padding = (p.def.padding ?? 2) * dpr
      const haloOut = p.def.halo
        ? {
            color: p.def.halo.color,
            width: p.def.halo.width * dpr,
            ...(p.def.halo.blur !== undefined ? { blur: p.def.halo.blur * dpr } : {}),
          }
        : undefined

      // iter-168 Phase A slice 2 — layout cache (single-anchor static).
      // Variable-anchor / radialOffset / multi-candidate / rotated
      // labels skip the cache (their per-anchor offset evaluation
      // needs intricate fingerprinting; not worth the risk for the
      // small share of labels they cover in OFM-class styles).
      // iter-190 RE-ENABLE — iter-175 reverted iter-167/168 because
      // the cached `GlyphInfo[]` references aliased atlas slots that
      // got reassigned mid-frame (one label's ensure() displacing a
      // cached glyph still indirected by a later label). Fix: keyed
      // by atlas generation. Cache entries store the generation at
      // write; on read, if `host.getGeneration()` differs, drop the
      // entry and recompute. Atlas eviction bumps generation, so any
      // stale slot pointer triggers a miss. Steady-state Paris z=18
      // pitch=70 idle frame budget was 78ms with no caching (probe
      // 2026-05-20) — label layout dominated. Re-enabling restores
      // the iter-167 / iter-168 perf gains correctly.
      const _isCacheable = !variableMode
        && candidates.length === 1
        && p.def.rotate === undefined
      let _layoutKey: number | undefined
      // Audit ④ B1 — exact source identity to reject `_layoutKey` hash
      // collisions on hit (the NUL separator keeps `font+text` distinct
      // from `fon+ttext`). Declared alongside `_layoutKey` so it reaches
      // the cache-store site below.
      let _srcKey: string | undefined
      if (_isCacheable) {
        const anchorStr = String(candidates[0])
        const cacheKey = textKeyFor(p.fontKey, p.text)
        _srcKey = p.fontKey + '\u0000' + p.text
        _layoutKey = layoutCacheKey(
          cacheKey, sizePx, letterSpacingPx,
          maxWidthPx === Infinity ? Infinity : maxWidthPx,
          lineHeightPx,
          justify, anchorStr,
          p.def.offset ? p.def.offset[0] : 0, p.def.offset ? p.def.offset[1] : 0,
          p.def.translate ? p.def.translate[0] : 0,
          p.def.translate ? p.def.translate[1] : 0,
          padding,
          haloOut ? haloOut.width : 0,
          haloOut?.blur ?? 0,
        )
        const hit = this._layoutCache.get(_layoutKey)
        // iter-190 generation guard + Audit ④ B1 text-identity guard.
        // hit.glyphs[] references atlas slots whose pxX / pxY change when
        // the slot is reassigned, so a generation bump invalidates them;
        // AND the 32-bit `_layoutKey` can collide, so a matching key may
        // belong to a DIFFERENT label — `srcKey` rejects that. Either
        // mismatch → drop the entry and fall through to recompute.
        if (hit !== undefined
            && layoutCacheEntryValid(hit, _srcKey, this.host.getGeneration())) {
          // iter-266 — count hit (after generation guard, so this
          // is a "real" hit that skipped the candidates loop).
          this._layoutCacheHits++
          // LRU touch.
          this._layoutCache.delete(_layoutKey)
          this._layoutCache.set(_layoutKey, hit)
          const drawX = p.anchorX + hit.dx
          const drawY = p.anchorY + hit.dy
          const haloLive = hit.haloGeom && p.def.halo
            ? {
                color: p.def.halo.color,
                width: hit.haloGeom.width,
                ...(hit.haloGeom.blur !== undefined ? { blur: hit.haloGeom.blur } : {}),
              }
            : undefined
          shaped.push({
            layouts: [{
              draw: {
                anchorX: drawX, anchorY: drawY,
                glyphs: hit.glyphs,
                fontSize: hit.sizePx,
                rasterFontSize: this.opts.rasterFontSize,
                color: p.def.color ?? [0, 0, 0, 1],
                halo: haloLive,
                letterSpacingPx: hit.letterSpacingPx,
                rotateRad: hit.rotateRad,
                glyphOffsets: hit.glyphOffsets,
                sdfRadius: this.opts.sdfRadius,
              },
              bbox: {
                minX: drawX - hit.padding,
                minY: drawY + hit.blockTop - hit.padding,
                maxX: drawX + hit.totalAdvance + hit.padding,
                maxY: drawY + hit.blockBottom + hit.padding,
              },
            }],
            allowOverlap: p.def.allowOverlap === true,
            ignorePlacement: p.def.ignorePlacement === true,
            sortKey: p.def.sortKey,
          })
          continue
        }
        // iter-266 — fell through: either no hit, or generation
        // mismatched. Both count as a miss for the harness probe.
        this._layoutCacheMisses++
      }

      const layouts: Array<{ draw: TextDraw; bbox: typeof shaped[number]['layouts'][number]['bbox'] }> = []
      for (const anchor of candidates) {
        let dx = 0, dy = 0
        if (anchor === 'left' || anchor.endsWith('-left')) dx = 0
        else if (anchor === 'right' || anchor.endsWith('-right')) dx = -totalAdvance
        else dx = -totalAdvance / 2
        // Vertical placement follows MapLibre `shapeLines`+`align()`:
        // a constant lineHeight box per line + a fixed
        // SHAPING_DEFAULT_OFFSET baseline, aligned by getAnchorAlignment
        // (top→0, bottom→1, else 0.5). `dy` no longer carries an
        // ink-metric anchor term — it's purely text-offset / translate
        // / variable below; the per-line baseline comes from `vlay`.
        const vAlign: 0 | 0.5 | 1 =
          (anchor === 'top' || anchor.startsWith('top-')) ? 0
          : (anchor === 'bottom' || anchor.startsWith('bottom-')) ? 1
          : 0.5
        // iter-242 (Plan AAA B.2) — pass arena so baselineY scratches
        // from FrameArena instead of allocating a fresh `new Array`.
        const vlay = mlVerticalLayout(vAlign, lines.length, lineHeightPx, sizePx, this._frameArena)
        if (variableMode) {
          // Per-anchor variable offset (MapLibre evaluateVariableOffset
          // / variable-anchor-offset), in em → scale by sizePx like
          // text-offset. Supersedes the plain text-offset add: MapLibre
          // folds text-offset INTO the variable offset and drops it
          // when text-radial-offset is also present.
          let vx = 0, vy = 0
          if (vao) {
            const pair = vao.find(pr => pr[0] === anchor)
            const off = pair ? pair[1] : [0, 0] as [number, number]
            ;[vx, vy] = variableAnchorOffsetEm(anchor, off)
          } else if (p.def.radialOffset !== undefined) {
            ;[vx, vy] = evaluateVariableOffsetEm(anchor, [p.def.radialOffset, 0], true)
          } else {
            ;[vx, vy] = evaluateVariableOffsetEm(
              anchor, p.def.offset ?? [0, 0], false)
          }
          dx += vx * sizePx
          dy += vy * sizePx
        } else if (p.def.offset) {
          dx += p.def.offset[0] * sizePx
          dy += p.def.offset[1] * sizePx
        }
        if (p.def.translate) {
          // text-translate is in pixels (Mapbox paint property), not
          // em-units, so it scales by DPR alone — independent of the
          // current font size. Stacks on top of text-offset.
          dx += p.def.translate[0] * dpr
          dy += p.def.translate[1] * dpr
        }
        const drawX = p.anchorX + dx
        const drawY = p.anchorY + dy
        // Per-glyph offsets for multi-line layout. Each line gets
        // justified within the bbox according to `justify`; lines
        // stack vertically by lineHeightPx.
        // Per-glyph offsets (x = within-line justified pen,
        // y = MapLibre per-line baseline). Emitted for EVERY label
        // (not just multi-line) so single- and multi-line take the
        // identical renderer path — the old split anchored them
        // differently and was the source of the #140 double-count.
        // Offsets are pure deltas from the draw anchor (drawX/drawY);
        // the renderer does base = d.anchor + offset.
        // iter-245 (Plan AAA B.3 prototype) — copy-on-cache pattern.
        // Allocate from arena (frame-scope) for the immediate render
        // path. If this layout is cacheable (see store site below),
        // a permanent `Float32Array(view)` copy is allocated at
        // cache-store time. Cache HITs return the permanent copy
        // (line ~1303), so the arena view is only valid within
        // THIS frame's prepare→render sequence.
        bumpAlloc('text-stage.prepare.glyphOffsets.point.FrameArena')
        const glyphOffsets = this._frameArena.allocF32(glyphs.length * 2)
        {
          // text-justify: auto resolves per anchor — left-anchors →
          // left, right-anchors → right, else center.
          const isLeftAnchor = anchor === 'left' || anchor.endsWith('-left')
          const isRightAnchor = anchor === 'right' || anchor.endsWith('-right')
          const effectiveJustify = justify === 'auto'
            ? (isLeftAnchor ? 'left' : isRightAnchor ? 'right' : 'center')
            : justify
          // iter-344/345 — centre-anchor ink fix. X-GIS's bearingY is a
          // baseline-relative POSITIVE ascent (incl. the pbf-rasterizer
          // recovery that flips ascender-relative latin `top` to a true
          // ascent), but `vlay`'s SHAPING_DEFAULT_OFFSET baseline is the
          // ascender-relative value from the MapLibre port. For vAlign=0.5
          // those two conventions don't cancel, leaving the ink ~1em
          // ABOVE the anchor — the user-reported "shield number floats
          // over its white box" (debug-labels box gap was a constant
          // +11px at fs10). For the centre case, shift the line's baseline
          // so its INK BAND centres on the line point. Computed PER LINE
          // from the line's max ascent/descent (NOT per glyph — that
          // de-aligned baselines within a mixed-height line e.g. 여(h22)
          // vs 도(h17), splitting "여의도" into staggered glyphs). All
          // glyphs in the line keep a SHARED baseline (correct typography)
          // and the band centres. Top/bottom (vAlign 0/1) keep the
          // MapLibre port untouched. Baked into glyphOffsets so the layout
          // cache + dump both see the corrected position.
          // One CONSTANT block shift (not per-line) so multi-line labels
          // keep their lineHeight spacing while the whole ink BLOCK
          // centres on the anchor. Drop the SHAPING baseline term and add
          // the block's ink-band half-offset (max ascent/descent over the
          // label). Per-line centring (iter-345) compressed 2-line spacing
          // into an overlap; a uniform shift preserves it.
          const shapingBaselineOff = (SHAPING_DEFAULT_OFFSET * sizePx) / ONE_EM
          let centreShift = 0
          if (vAlign === 0.5) {
            let maxAsc = 0, maxDesc = 0
            for (let gi = 0; gi < glyphs.length; gi++) {
              const g = glyphs[gi]!
              if (g.height <= 0) continue  // skip blanks (junk metrics)
              const sc = sizePx / (g.rasterFontSize ?? this.opts.rasterFontSize)
              const asc = g.bearingY * sc
              const desc = (g.height - g.bearingY) * sc
              if (asc > maxAsc) maxAsc = asc
              if (desc > maxDesc) maxDesc = desc
            }
            centreShift = -shapingBaselineOff + (maxAsc - maxDesc) / 2
          }
          for (let li = 0; li < lines.length; li++) {
            const ln = lines[li]!
            let lineX = 0
            if (effectiveJustify === 'right') lineX = totalAdvance - ln.width
            else if (effectiveJustify === 'left') lineX = 0
            else lineX = (totalAdvance - ln.width) * 0.5
            const lineY = vlay.baselineY[li]! + centreShift
            let pen = lineX
            for (let gi = ln.start; gi < ln.end; gi++) {
              glyphOffsets[gi * 2] = pen
              glyphOffsets[gi * 2 + 1] = lineY
              pen += advances[gi]!
              if (gi < ln.end - 1) pen += letterSpacingPx
            }
          }
        }
        const bbox = {
          minX: drawX - padding,
          minY: drawY + vlay.blockTop - padding,
          maxX: drawX + totalAdvance + padding,
          maxY: drawY + vlay.blockBottom + padding,
        }
        layouts.push({
          draw: {
            anchorX: drawX,
            anchorY: drawY,
            glyphs,
            fontSize: sizePx,
            rasterFontSize: this.opts.rasterFontSize,
            color: p.def.color ?? [0, 0, 0, 1],
            halo: haloOut,
            letterSpacingPx,
            rotateRad: p.def.rotate ? p.def.rotate * Math.PI / 180 : undefined,
            glyphOffsets,
            sdfRadius: this.opts.sdfRadius,
          },
          bbox,
        })
        // iter-168 cache store (cold-path single-iter cacheable case).
        if (_isCacheable && _layoutKey !== undefined) {
          if (this._layoutCache.size >= TextStage.LAYOUT_CACHE_MAX) {
            const oldest = this._layoutCache.keys().next().value
            if (oldest !== undefined) this._layoutCache.delete(oldest)
          }
          // iter-245 (Plan AAA B.3) — copy arena view to a permanent
          // heap-backed Float32Array for cache storage. The arena
          // view is only valid until next beginFrame; the cache
          // outlives many frames, so it must hold its own bytes.
          // `new Float32Array(view)` copies the underlying data.
          const cachedGlyphOffsets = new Float32Array(glyphOffsets)
          this._layoutCache.set(_layoutKey, {
            dx, dy,
            totalAdvance, padding,
            blockTop: vlay.blockTop,
            blockBottom: vlay.blockBottom,
            glyphOffsets: cachedGlyphOffsets, glyphs,
            generation: this.host.getGeneration(),
            // Audit ④ B1 — `_isCacheable` here ⟹ `_srcKey` was assigned
            // above; `?? ''` only satisfies the `string | undefined` type.
            srcKey: _srcKey ?? '',
            haloGeom: haloOut
              ? {
                  width: haloOut.width,
                  ...(haloOut.blur !== undefined ? { blur: haloOut.blur } : {}),
                }
              : undefined,
            sizePx, letterSpacingPx,
            rotateRad: p.def.rotate ? p.def.rotate * Math.PI / 180 : undefined,
          })
        }
      }
      // iter 152: z0-halo probe capture. haloK=3 mirrors
      // packUniforms' pxToSdf (text-renderer.ts:602-609) exactly so
      // haloWidthNorm captured here == the buf[12] the shader receives.
      this._diag.captureHalo(p.text, sizePx, this.opts.rasterFontSize, haloOut ? haloOut.width : 0)
      shaped.push({
        layouts,
        allowOverlap: p.def.allowOverlap === true,
        ignorePlacement: p.def.ignorePlacement === true,
        sortKey: p.def.sortKey,
      })
    }
    perfMarkEnd('stage-prepare.point-loop')

    // Phase 1b: shape curved line labels. Each glyph rides a
    // different point on the polyline with the local tangent rotation.
    // The static bbox used for collision is the AABB of all glyph
    // centres (rough but cheap; precise oriented bboxes are overkill
    // for label-vs-label dedupe at typical zoom).
    //
    // Shared per-phase scratches. Sized once across the curved-label
    // loop so we don't allocate `advances` / `cumLen` arrays per
    // label. The per-label sample loop also targets a shared
    // 3-element tuple instead of returning a fresh `{ x, y, angle }`
    // closure result per glyph — that was the dominant GC source
    // when many road labels project onto the same frame.
    let _advanceScratch = new Float32Array(0)
    let _cumLenScratch = new Float32Array(0)
    const _sampleOut: [number, number, number] = [0, 0, 0]
    // iter-265 — sub-phase drill. Curved-label loop covers ensure
    // String + per-glyph advance fill + cumulative length + keep
    // upright check + per-glyph sample (atan2 / Math.sin / Math.cos)
    // + glyphOffsets/Rotations arena fill. Dominates prepare() on
    // road/transportation heavy fixtures (Liberty highways at z>=12).
    perfMarkStart('stage-prepare.line-loop')
    for (const p of this.pendingLine) {
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      if (glyphs.length === 0) continue
      // Mirror the point-loop CJK display-size floor (~:716): a dense Han
      // glyph minified from the 24-px atlas to the low-zoom size renders as
      // a solid box. Curved/line labels were missing this floor, so CJK road
      // labels boxed out at low zoom. Everything downstream (verticalOffset,
      // halfH, letterSpacing, advances) derives from sizePx → single site.
      const rawSizePx = p.def.size * dpr
      const sizePx = hasCjkIdeograph(p.text)
        ? Math.max(rawSizePx, CJK_MIN_DISPLAY_PX * dpr)
        : rawSizePx
      // Same per-font override path as the point-label branch above —
      // see the comment there for rationale. Curve labels reuse the
      // same letter-spacing semantics (extra em between adjacent
      // glyphs along the polyline arc).
      const typo = this.typographyFor(p.fontKey)
      const letterSpacingPx = ((p.def.letterSpacing ?? 0) + typo.letterSpacingEm) * sizePx
      // Total label width along the polyline (sum of advances + spacing).
      if (_advanceScratch.length < glyphs.length) {
        _advanceScratch = new Float32Array(glyphs.length * 2)
      }
      const advances = _advanceScratch
      let totalAdvancePx = 0
      for (let gi = 0; gi < glyphs.length; gi++) {
        const gg = glyphs[gi]!
        const adv = gg.advanceWidth
          * (sizePx / (gg.rasterFontSize ?? this.opts.rasterFontSize))
        advances[gi] = adv
        totalAdvancePx += adv
      }
      totalAdvancePx += letterSpacingPx * Math.max(0, glyphs.length - 1)
      // Cumulative polyline length + per-vertex distance for fast
      // distance-to-position lookup.
      const px = p.polylineX, py = p.polylineY
      const n = px.length
      if (n < 2) continue
      if (_cumLenScratch.length < n) {
        _cumLenScratch = new Float32Array(n * 2)
      }
      const cumLen = _cumLenScratch
      cumLen[0] = 0
      for (let i = 1; i < n; i++) {
        const dx = px[i]! - px[i - 1]!
        const dy = py[i]! - py[i - 1]!
        cumLen[i] = cumLen[i - 1]! + Math.sqrt(dx * dx + dy * dy)
      }
      const totalLineLen = cumLen[n - 1]!
      // Skip when label can't fit — Mapbox drops it rather than truncate.
      if (totalAdvancePx > totalLineLen) continue
      let startS = p.centerOffsetPx - totalAdvancePx * 0.5
      // Skip when the requested centre + label extends past the polyline.
      if (startS < 0 || startS + totalAdvancePx > totalLineLen + 0.5) continue

      // Mapbox `text-keep-upright` (default true): when the label's
      // overall direction would render text upside-down, flip the
      // entire run by walking the polyline in reverse. Per-glyph
      // flipping at the threshold caused adjacent glyphs across a
      // 90°-tangent boundary to face opposite ways — visibly broken
      // on roads with mild curves. Decide ONCE based on the tangent
      // sampled at the label's centre; reverse the polyline walk
      // direction if needed so all glyphs rotate coherently.
      const keepUpright = p.def.keepUpright !== false
      let walkReversed = false
      if (keepUpright) {
        // Sample tangent at label centre to gauge overall direction.
        let cIdx = 0
        const cs = p.centerOffsetPx
        while (cIdx < n - 2 && cumLen[cIdx + 1]! < cs) cIdx++
        const dxMid = px[cIdx + 1]! - px[cIdx]!
        const dyMid = py[cIdx + 1]! - py[cIdx]!
        const midAngle = Math.atan2(dyMid, dxMid)
        if (midAngle > Math.PI / 2 || midAngle < -Math.PI / 2) {
          walkReversed = true
          // Mirror startS so glyph 0 still ends up at the same screen
          // position the user expects — but now travelling toward the
          // polyline's start instead of its end.
          startS = totalLineLen - p.centerOffsetPx - totalAdvancePx * 0.5
        }
      }

      // Sample point at distance `s` along the polyline — writes to
      // `_sampleOut` shared tuple [x, y, angle] (no per-call object
      // alloc). When walkReversed, distances are measured from the
      // polyline END; the angle is flipped 180°.
      let segIdx = 0
      const sampleAt = (s: number): void => {
        const sFwd = walkReversed ? totalLineLen - s : s
        while (segIdx < n - 2 && cumLen[segIdx + 1]! < sFwd) segIdx++
        while (segIdx > 0 && cumLen[segIdx]! > sFwd) segIdx--
        const segLen = cumLen[segIdx + 1]! - cumLen[segIdx]!
        const t = segLen > 0 ? (sFwd - cumLen[segIdx]!) / segLen : 0
        const ax = px[segIdx]!, ay = py[segIdx]!
        const bx = px[segIdx + 1]!, by = py[segIdx + 1]!
        _sampleOut[0] = ax + (bx - ax) * t
        _sampleOut[1] = ay + (by - ay) * t
        let angle = Math.atan2(by - ay, bx - ax)
        if (walkReversed) angle += Math.PI
        _sampleOut[2] = angle
      }
      // iter-246 (Plan AAA B.2) — curved label per-glyph arrays via
      // FrameArena. Curved labels are NOT stored in _layoutCache
      // (only point labels are — see line ~1455 cache store branch),
      // so the arena view's lifetime is purely prepare() → render
      // within the same frame. Watermark resets at next beginFrame.
      bumpAlloc('text-stage.curved.glyphOffsets.FrameArena')
      const glyphOffsets = this._frameArena.allocF32(glyphs.length * 2)
      bumpAlloc('text-stage.curved.glyphRotations.FrameArena')
      const glyphRotations = this._frameArena.allocF32(glyphs.length)
      // Per-glyph centre = startS + sum(prev advances) + currentAdvance/2.
      // Vertical alignment: sample.y is the polyline anchor; the text
      // renderer treats it as the glyph BASELINE (glyphs grow upward
      // from there via bearingY). For along-path labels we want the
      // VISUAL CENTRE of the glyph row sitting on the line — meaning
      // the line passes through the cap-height midpoint, not under
      // the descender. Shift each anchor PERPENDICULAR to the local
      // tangent (so the offset still tracks curving roads / lat
      // lines) by ~0.35 * sizePx, which puts the cap-height midpoint
      // on the polyline for a typical Latin face. Earlier code used
      // sample.y as-is and the glyph rendered ABOVE the line —
      // visible on demotiles Tropic of Cancer / Equator labels and
      // on OFM road labels that fall inside the road carriageway.
      const verticalOffsetPx = sizePx * 0.4
      let cursor = startS
      let gminX = Infinity, gmaxX = -Infinity, gminY = Infinity, gmaxY = -Infinity
      for (let gi = 0; gi < glyphs.length; gi++) {
        const adv = advances[gi]!
        // Sample at the LEFT edge of the advance box, NOT its centre.
        // The text-renderer's bearing application places the visible
        // glyph's LEFT edge at `baseX + bearingX*scale`, so passing
        // the polyline position at advance-box-left here yields the
        // correct per-glyph anchor — `Tropic of Cancer` reads with
        // even spacing.
        // Sampling at the box centre (the pre-fix code) was off by
        // `bearingX + glyphWidth/2` per glyph; since glyph widths
        // vary, gap distance varied too — visible as "Tr o pi c of
        // Cancer" with wide / narrow alternations.
        sampleAt(cursor)
        const sx = _sampleOut[0], sy = _sampleOut[1], sAngle = _sampleOut[2]
        // Perpendicular shift: rotate (0, verticalOffsetPx) by the
        // sample's tangent angle. cos/sin of (angle + 90°) =
        // (-sin angle, cos angle). Multiply by the desired offset.
        const perpX = -Math.sin(sAngle) * verticalOffsetPx
        const perpY = Math.cos(sAngle) * verticalOffsetPx
        glyphOffsets[gi * 2] = sx + perpX
        glyphOffsets[gi * 2 + 1] = sy + perpY
        glyphRotations[gi] = sAngle
        if (sx < gminX) gminX = sx
        if (sx > gmaxX) gmaxX = sx
        if (sy < gminY) gminY = sy
        if (sy > gmaxY) gmaxY = sy
        cursor += adv + (gi < glyphs.length - 1 ? letterSpacingPx : 0)
      }
      // Line labels reference the polyline directly — anchor is at
      // origin (0,0); per-glyph offsets are absolute screen coords
      // already (the renderer computes baseX = anchorX + offset[0]
      // so we set anchor=0 and glyphOffsets[i] = sample.x).
      const haloOut = p.def.halo
        ? {
            color: p.def.halo.color,
            width: p.def.halo.width * dpr,
            ...(p.def.halo.blur !== undefined ? { blur: p.def.halo.blur * dpr } : {}),
          }
        : undefined
      const padding = (p.def.padding ?? 2) * dpr
      const halfH = sizePx * 0.5
      const draw: TextDraw = {
        anchorX: 0,
        anchorY: 0,
        glyphs,
        fontSize: sizePx,
        rasterFontSize: this.opts.rasterFontSize,
        color: p.def.color ?? [0, 0, 0, 1],
        halo: haloOut,
        letterSpacingPx,
        glyphOffsets,
        glyphRotations,
        sdfRadius: this.opts.sdfRadius,
      }
      shaped.push({
        layouts: [{
          draw,
          bbox: {
            minX: gminX - halfH - padding,
            minY: gminY - halfH - padding,
            maxX: gmaxX + halfH + padding,
            maxY: gmaxY + halfH + padding,
          },
        }],
        allowOverlap: p.def.allowOverlap === true,
        ignorePlacement: p.def.ignorePlacement === true,
        sortKey: p.def.sortKey,
        pairKey: p.pairKey,
      })
    }
    perfMarkEnd('stage-prepare.line-loop')

    // Phase 2: greedy bbox collision.
    //
    // Mapbox / MapLibre collision precedence:
    //   (1) Mapbox `symbol-sort-key` — lower keys win. This is the
    //       explicit author-controlled ordering and trumps the
    //       implicit layer-order rule.
    //   (2) Layer order — a label in a LATER layer beats an earlier
    //       layer's label. The mental model is "the layer you draw
    //       on top wins the screen real-estate contest" — countries
    //       (last in OFM Bright) beat water_name labels (first) at
    //       the antimeridian; POI labels (mid-stack) beat road
    //       shields when they collide.
    //
    // Our `pending` queue is populated in style order — water first,
    // country last — because map.ts iterates showCommands forward.
    // greedyPlaceBboxes is first-wins, so a naïve forward call lets
    // water labels claim the bbox real-estate and drops the country
    // ones. That's the wrong precedence and visibly so on low-zoom
    // mobile views (multiple sea names crowd out country labels
    // around the antimeridian).
    //
    // Strategy: when ANY shaped item carries sortKey, defer ordering
    // to greedyPlaceBboxes' stable sortKey-ascending pass. When no
    // sortKey is set, iterate the collision input in REVERSE so
    // later layers place first (legacy byte-identical path). Draw
    // order stays in original `shaped` order so
    // the layered rendering effect (country text on top of water
    // halo) is preserved — only the collision dedup priority flips.
    // iter-265 — sub-phase drill. Collision = CollisionItem.map +
    // greedyPlaceBboxes + per-shape place loop. greedy is O(N²) so
    // dense-label scenes (low-z world view) spend a chunk here.
    perfMarkStart('stage-prepare.collision')
    const collisionInput: CollisionItem[] = shaped.map(s => ({
      bboxes: s.layouts.map(l => l.bbox),
      allowOverlap: s.allowOverlap,
      ignorePlacement: s.ignorePlacement,
      sortKey: s.sortKey,
    }))
    // When ANY shaped item carries an explicit sortKey, greedy­Place­
    // Bboxes handles priority via stable sort by sortKey ascending —
    // we don't need (and shouldn't apply) the reverse-iteration
    // layer-order tie-break, because that would put high-sortKey
    // labels in front of low-sortKey ones. When no item sets sortKey,
    // keep the legacy reverse trick so "later layers win" behaviour
    // stays byte-identical for styles without symbol-sort-key.
    let placements
    let anySortKey = false
    for (const s of shaped) if (s.sortKey !== undefined) { anySortKey = true; break }
    if (anySortKey) {
      placements = greedyPlaceBboxes(collisionInput)
    } else {
      const reversed: CollisionItem[] = []
      for (let i = collisionInput.length - 1; i >= 0; i--) reversed.push(collisionInput[i]!)
      const placementsReversed = greedyPlaceBboxes(reversed)
      placements = new Array(shaped.length) as typeof placementsReversed
      for (let i = 0; i < placementsReversed.length; i++) {
        placements[shaped.length - 1 - i] = placementsReversed[i]!
      }
    }
    const draws: TextDraw[] = []
    // Iter 112 paired-symbol collision: stamp pairKeys of REJECTED
    // text labels so IconStage.prepare can drop the matching icon.
    // MapLibre treats text + icon as one symbol — both placed or both
    // dropped. Without this, every dispatched icon survived (no
    // IconStage collision) while text could be collision-rejected,
    // visible as "white shield boxes without road numbers" on
    // highway-shield-* layers.
    this.droppedPairKeys.clear()
    // shaped[i] is built 1:1 from this.pending in iteration order
    // above (line ~941). The collision-input may reorder but each
    // ShapedLabel still references its source PendingLabel by index.
    for (let i = 0; i < shaped.length; i++) {
      const placement = placements[i]!
      // Point labels carry pairKey on their PendingLabel (shaped[] is
      // 1:1 with this.pending for the point range). Curved line shields
      // carry it on the shaped entry instead — the line-loop skips
      // unshapeable labels so pendingLine[] indices don't line up.
      const pairKey = this.pending[i]?.pairKey ?? shaped[i]!.pairKey
      if (placement.placed) {
        draws.push(shaped[i]!.layouts[placement.chosen]!.draw)
      } else if (pairKey !== undefined) {
        this.droppedPairKeys.add(pairKey)
      }
    }
    perfMarkEnd('stage-prepare.collision')

    // iter-265 — sub-phase drill. Emit = GPU flush (dirty SDF
    // uploads) + setDraws (uniform pack into FrameArena +
    // renderer state). Expected small but exposes GPU upload
    // pressure when glyph cache misses spike.
    perfMarkStart('stage-prepare.emit')
    // Flush dirty SDFs to GPU BEFORE setDraws — guarantees every
    // referenced glyph slot is resident when the renderer reads
    // page0.width to compute UVs.
    this.gpu.flush()
    // iter-327 — live glyph-placement dump (off unless a filter is set).
    // Reads `draws` AFTER collision and BEFORE setDraws; the call stays
    // at this exact point in the emit sequence.
    this._diag.captureDump(draws, this.opts.slotSize, this.opts.rasterFontSize)
    this.renderer.setDraws(draws)
    this._diag.setDrawnCount(draws.length)
    perfMarkEnd('stage-prepare.emit')
  }

  /** Encode the prepared draws onto the pass. Safe to call without
   *  a prior prepare() — emits nothing in that case. */
  render(pass: GPURenderPassEncoder, viewport: { width: number; height: number }): void {
    this.renderer.draw(pass, viewport)
  }

  /** S16 skip guard — see `_lastPrepareFullyResolved`. False until a prepare()
   *  completes with every label's glyphs present; the label pass must not skip
   *  prepare while this is false. */
  wasLastPrepareFullyResolved(): boolean {
    return this._lastPrepareFullyResolved
  }

  /** Reset the pending queue for the next frame. Call after render()
   *  (or immediately at frame start). */
  reset(): void {
    this.pending.length = 0
    this.pendingLine.length = 0
  }

  destroy(): void {
    this.renderer.destroy()
    this.gpu.destroy()
  }
}

