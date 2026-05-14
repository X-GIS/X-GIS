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
import { createRasterizer, type GlyphRasterizer } from './sdf/glyph-rasterizer'
import { GlyphPbfCache } from './sdf/pbf/glyph-pbf-cache'
import { PbfRasterizer } from './sdf/pbf-rasterizer'
import { TextRenderer, type TextDraw } from './text-renderer'
import { greedyPlaceBboxes, type CollisionItem } from './text-collision'
import { FONT_KEY_SENTINEL } from './sdf/glyph-rasterizer'
import { applyTextTransform, stripCurveLineExtraScripts } from './text-stage-helpers'

/** Compose the rasterizer-visible font key for one label.
 *
 *  Format when weight/style are unset: plain CSS family-list string
 *  ("Foo, Bar, sans-serif"). When the LabelDef carries a fontWeight
 *  or fontStyle, the helper prepends a sentinel-delimited prefix:
 *
 *      \x01<style>\x01<weight>\x01<family-list>
 *
 *  glyph-rasterizer.ts detects the sentinel and unpacks the three
 *  fields into a properly-ordered CSS font shorthand
 *  ("italic 700 24px Foo, sans-serif"). Without this, the only way
 *  to carry weight info through ctx.font is to embed it in the
 *  family name itself, which CSS parses literally and the browser
 *  silently falls back to its default font — the root cause of "all
 *  Mapbox labels look the same Regular weight".
 *
 *  CJK_FALLBACK_CHAIN is appended after any user-supplied family
 *  list so Mapbox styles that only declare "Noto Sans Regular"
 *  still pick up a Korean / Japanese / Chinese font from the host
 *  OS for glyphs the primary family lacks. */
export function composeFontKey(def: LabelDef, defaultFamily: string): string {
  const family = def.font && def.font.length > 0
    ? def.font.map(f => f.includes(' ') ? `"${f}"` : f).join(',')
      + ',' + CJK_FALLBACK_CHAIN
    : defaultFamily
  if (def.fontStyle === undefined && def.fontWeight === undefined) {
    return family
  }
  const style = def.fontStyle ?? 'normal'
  const weight = def.fontWeight ?? 400
  return `${FONT_KEY_SENTINEL}${style}${FONT_KEY_SENTINEL}${weight}${FONT_KEY_SENTINEL}${family}`
}

export interface TextStageOptions {
  /** Atlas slot side length in pixels. Each glyph rasterises into
   *  one slot; slot must be larger than (rasterFontSize + 2*sdfRadius). */
  slotSize?: number
  /** Atlas page side length in pixels. Multiple of slotSize. */
  pageSize?: number
  /** Pixel size each glyph is rasterised at. Display sizes scale
   *  via the SDF threshold smoothing in the shader. Picking ~24px
   *  gives good fidelity from 12px up to 64px display. */
  rasterFontSize?: number
  /** SDF falloff radius in pixels. Determines edge smoothness +
   *  halo headroom. */
  sdfRadius?: number
  /** Default font key when LabelDef doesn't specify a font stack. */
  defaultFont?: string
  /** Optional rasterizer override (e.g. a worker-backed implementation
   *  injected by the integration layer). When omitted, picks the best
   *  available for the current environment via createRasterizer(). */
  rasterizer?: GlyphRasterizer
  /** Style-spec `glyphs` URL template (`{fontstack}` + `{range}`).
   *  When provided AND no explicit `rasterizer` is supplied, the stage
   *  wraps the Canvas2D rasterizer with one that fetches MapLibre SDF
   *  PBF glyphs in the background. Cache hits use the PBF glyph; misses
   *  return the Canvas2D fallback immediately and schedule a fetch.
   *  When the fetch lands, the affected slot is re-rasterised on the
   *  next prepare() and the visual upgrades silently. Failed fetches
   *  (offline / 404 / CORS) stay on Canvas2D for the session. */
  glyphsUrl?: string
}

// Slot must fit (rasterFontSize + 2*sdfRadius) — ascenders/descenders
// of a 32-px raster font extend ~38-40 px, plus 8 px SDF radius on
// each side ⇒ 54-56 px needed. Round to 64 for some headroom on
// CJK/diacritics. The previous 24-px raster lost too much stroke
// detail on Hangul / Han and visibly softened any label drawn above
// ~32 px display size (POI labels at high zoom).
//
// pageSize 2304 = 36 slots/side at slotSize 64 → 1296 slots per
// page. Multi-page atlases handle CJK-heavy maps via the renderer's
// per-page bind groups; no change to that path.
//
// defaultFont chains common CJK fallbacks AFTER sans-serif so an
// engine-level label without a Mapbox font stack still reads
// Hangul/Han correctly on every host OS we ship on (macOS / Win /
// Linux). Per-label font stacks coming from Mapbox styles get the
// same fallback chain appended in addLabel/addCurvedLineLabel.
const CJK_FALLBACK_CHAIN = '"Noto Sans CJK KR","Apple SD Gothic Neo","Malgun Gothic","Microsoft YaHei","Noto Sans CJK JP","Hiragino Sans","Yu Gothic",sans-serif'
const DEFAULTS: Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl'>> = {
  slotSize: 64,
  pageSize: 2304,
  rasterFontSize: 32,
  sdfRadius: 8,
  defaultFont: CJK_FALLBACK_CHAIN,
}

interface PendingLabel {
  text: string
  anchorX: number
  anchorY: number
  def: LabelDef
  fontKey: string
}

interface PendingLineLabel {
  text: string
  /** Polyline already projected to screen pixels by the caller. */
  polylineX: Float32Array
  polylineY: Float32Array
  /** Distance along the polyline (px) where the label centre sits. */
  centerOffsetPx: number
  def: LabelDef
  fontKey: string
}

export class TextStage {
  readonly host: GlyphAtlasHost
  readonly gpu: GlyphAtlasGPU
  readonly renderer: TextRenderer
  readonly opts: Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl'>>
  private readonly pending: PendingLabel[] = []
  private readonly pendingLine: PendingLineLabel[] = []
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
    this.opts = { ...DEFAULTS, ...options } as Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl'>>
    // Rasterizer selection:
    //   1. explicit override   → use it as-is
    //   2. glyphsUrl supplied  → wrap Canvas2D with PbfRasterizer so
    //      MapLibre SDF PBF glyphs upgrade the visual when available
    //      (and the Canvas2D path keeps every other case identical to
    //      the no-glyphsUrl flow)
    //   3. neither             → plain Canvas2D / Mock (existing path)
    //
    // The PBF wrapper's onLanded callback forward-references `this.host`
    // via an arrow — only invoked async after the host is assigned a few
    // lines below, so the temporal coupling is sound.
    let rasterizer: GlyphRasterizer
    if (options.rasterizer) {
      rasterizer = options.rasterizer
    } else if (options.glyphsUrl) {
      const fallback = createRasterizer()
      const cache = new GlyphPbfCache({ glyphsUrl: options.glyphsUrl })
      rasterizer = new PbfRasterizer({
        fallback, cache,
        onLanded: (fontKey, codepoint) => this.host.invalidate(fontKey, codepoint),
      })
    } else {
      rasterizer = createRasterizer()
    }
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

  /** Set the device pixel ratio for the current frame. Call before
   *  prepare(). Sizes/offsets in LabelDef are CSS-px convention;
   *  multiplying by DPR matches the physical-pixel anchor space. */
  setDpr(dpr: number): void {
    this.dpr = dpr > 0 ? dpr : 1
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
  ): void {
    const text = resolveText(value, props, this.cameraZoom)
    if (text.length === 0) return
    // stripCurveLineExtraScripts drops everything from the first LF
    // onwards — Mapbox bilingual labels render only the primary
    // script along curves (Latin\nNonLatin would otherwise lay both
    // scripts head-to-tail along the road).
    const transformed = stripCurveLineExtraScripts(applyTextTransform(text, def.transform))
    if (transformed.length === 0) return
    if (this._debugHook && polylineX.length > 0) {
      // Approximate the curve's anchor as its first vertex — enough
      // for the debug overlay to pin down a screen position. Mid-
      // point would require walking centerOffsetPx, which isn't
      // worth the cost for a debug-only path.
      this._debugHook(transformed, polylineX[0]!, polylineY[0]!, 'curve')
    }
    if (this._traceRecorder !== null && polylineX.length > 0) {
      this._traceRecorder.recordLabel({
        layerName: layerName ?? '',
        text: transformed,
        color: (def.color ?? [0, 0, 0, 1]) as readonly [number, number, number, number],
        halo: def.halo ? {
          color: def.halo.color as readonly [number, number, number, number],
          width: def.halo.width,
          blur: def.halo.blur ?? 0,
        } : undefined,
        fontFamily: (def.font && def.font[0]) ?? 'sans-serif',
        fontWeight: def.fontWeight ?? 400,
        fontStyle: def.fontStyle ?? 'normal',
        sizePx: def.size,
        placement: 'curve',
        state: 'placed',
        anchorScreenX: polylineX[0]!,
        anchorScreenY: polylineY[0]!,
      })
    }
    this.pendingLine.push({
      text: transformed,
      polylineX, polylineY, centerOffsetPx,
      def,
      fontKey: fontKey ?? composeFontKey(def, this.opts.defaultFont),
    })
  }

  /** Queue one label for the current frame. Resolve text from a
   *  TextValue + feature props inline; caller already knows the
   *  feature's screen anchor (after projection). Empty resolved
   *  text is silently skipped. */
  addLabel(
    value: TextValue,
    props: FeatureProps,
    anchorScreenX: number,
    anchorScreenY: number,
    def: LabelDef,
    fontKey?: string,
    layerName?: string,
  ): void {
    const text = resolveText(value, props, this.cameraZoom)
    if (text.length === 0) return
    const transformed = applyTextTransform(text, def.transform)
    if (this._debugHook) {
      this._debugHook(transformed, anchorScreenX, anchorScreenY, 'point')
    }
    if (this._traceRecorder !== null) {
      this._traceRecorder.recordLabel({
        layerName: layerName ?? '',
        text: transformed,
        color: (def.color ?? [0, 0, 0, 1]) as readonly [number, number, number, number],
        halo: def.halo ? {
          color: def.halo.color as readonly [number, number, number, number],
          width: def.halo.width,
          blur: def.halo.blur ?? 0,
        } : undefined,
        fontFamily: (def.font && def.font[0]) ?? 'sans-serif',
        fontWeight: def.fontWeight ?? 400,
        fontStyle: def.fontStyle ?? 'normal',
        sizePx: def.size,
        placement: 'point',
        state: 'placed',  // collision result not known yet at submit time
        anchorScreenX,
        anchorScreenY,
      })
    }
    this.pending.push({
      text: transformed,
      anchorX: anchorScreenX,
      anchorY: anchorScreenY,
      def,
      fontKey: fontKey ?? composeFontKey(def, this.opts.defaultFont),
    })
  }

  /** Realize queued labels into atlas + GPU + draw list. Caller
   *  invokes this once per frame after all addLabel() calls and
   *  before encoding the render pass; render() then encodes the
   *  draws onto the supplied pass. */
  prepare(): void {
    if (this.pending.length === 0 && this.pendingLine.length === 0) {
      this.renderer.setDraws([])
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
    }
    const shaped: ShapedLabel[] = []
    const dpr = this.dpr
    for (const p of this.pending) {
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      // CSS-px → physical-px. The atlas is in physical px (anchors
      // arrive projected to canvas.width/height) so every length
      // sourced from the LabelDef has to scale by DPR.
      const sizePx = p.def.size * dpr
      // letter-spacing in em units (Mapbox convention) — multiplies
      // the display font size to produce extra px between adjacent
      // glyphs. Applied as a per-glyph advance bump that the
      // text-renderer reads via the glyph's effective advance.
      const letterSpacingPx = (p.def.letterSpacing ?? 0) * sizePx
      const scale = sizePx / this.opts.rasterFontSize
      // Multiline layout: greedy word-break at maxWidth (em-units →
      // px). When unset, treat as Infinity = single line.
      const maxWidthPx = p.def.maxWidth !== undefined
        ? p.def.maxWidth * sizePx : Infinity
      const lineHeightEm = p.def.lineHeight ?? 1.2
      const lineHeightPx = lineHeightEm * sizePx
      const justify = p.def.justify ?? 'center'

      // Compute per-line glyph ranges + line widths.
      interface LineRange { start: number; end: number; width: number }
      const lines: LineRange[] = []
      let lineStart = 0
      let lineW = 0
      let lastSpaceI = -1
      let lastSpaceW = 0
      let maxHeight = 0
      const advances: number[] = new Array(glyphs.length)
      for (let gi = 0; gi < glyphs.length; gi++) {
        const g = glyphs[gi]!
        const adv = g.advanceWidth * scale
        advances[gi] = adv
        if (g.height * scale > maxHeight) maxHeight = g.height * scale
      }
      for (let gi = 0; gi < glyphs.length; gi++) {
        const g = glyphs[gi]!
        const adv = advances[gi]!
        const ls = gi < glyphs.length - 1 ? letterSpacingPx : 0
        // Explicit U+000A (LF) — Mapbox styles emit `\n` inside
        // `text-field` to stack bilingual names ("Seoul\n서울"). The
        // newline glyph has zero advance from Canvas2D, so without
        // this branch the two names render side-by-side on one line
        // and the user perceives "both languages drawn at once".
        // Skip the LF glyph and start a fresh line at gi+1.
        if (g.codepoint === 0x0a) {
          lines.push({ start: lineStart, end: gi, width: lineW })
          lineStart = gi + 1
          lineW = 0
          lastSpaceI = -1
          continue
        }
        // Track break candidates at U+0020 (space). Spaces adjacent
        // to U+002F (`/`) are NOT break candidates — multi-language
        // compound names like "Sea of Japan / 日本海 / 동해" would
        // otherwise wrap into "Sea of\nJapan /\n日本海 /\n동해…"
        // (slashes orphaned at line ends). MapLibre keeps the slash
        // wedged between its operands. The check looks at the previous
        // codepoint (already a glyph) AND the next codepoint (look-
        // ahead by one glyph) — both must be non-slash for the space
        // to register.
        if (g.codepoint === 0x20) {
          const prevCp = gi > 0 ? glyphs[gi - 1]!.codepoint : 0
          const nextCp = gi < glyphs.length - 1 ? glyphs[gi + 1]!.codepoint : 0
          // Fullwidth slash U+FF0F has the same orphan-risk as ASCII
          // U+002F in CJK compound names ("東京／大阪"). Middle-dots
          // (U+00B7, U+30FB) bind tighter and rarely sit next to a
          // space — not added.
          const isSlash = (cp: number) => cp === 0x2f || cp === 0xff0f
          if (!isSlash(prevCp) && !isSlash(nextCp)) {
            lastSpaceI = gi
            lastSpaceW = lineW
          }
        } else if (g.codepoint === 0x3000) {
          // U+3000 (ideographic space) — CJK convention uses it as a
          // wide between-token separator ("東京 大阪"). Same break
          // semantics as ASCII space; the slash-orphan guard doesn't
          // apply (rarely wrapped around slashes in practice). Dropped
          // at wrap via `lineStart = lastSpaceI + 1` like U+0020.
          lastSpaceI = gi
          lastSpaceW = lineW
        }
        if (lineW + adv > maxWidthPx && lastSpaceI > lineStart) {
          // Wrap at the most recent space. The space itself is
          // dropped (it would otherwise sit at the end of the line).
          lines.push({ start: lineStart, end: lastSpaceI, width: lastSpaceW })
          lineStart = lastSpaceI + 1
          lineW = 0
          // Non-wrap branch (below) adds `advance + post-glyph
          // letter-spacing` per iter, so lineW semantically includes
          // a "trailing spacing slot" for the next glyph. Match that
          // here — for each carry-over glyph add advance + trailing
          // spacing (zero only when j is the global last glyph).
          // Skipping the trailing slot under-counts by one letter-
          // spacing per wrap, drifting wrap positions on caps-tracking
          // styles.
          for (let j = lineStart; j <= gi; j++) {
            lineW += advances[j]!
            if (j < glyphs.length - 1) lineW += letterSpacingPx
          }
          lastSpaceI = -1
        } else {
          lineW += adv + ls
        }
      }
      lines.push({ start: lineStart, end: glyphs.length, width: lineW })
      // Total bounding box width = max line width.
      let totalAdvance = 0
      for (const ln of lines) if (ln.width > totalAdvance) totalAdvance = ln.width
      const totalHeight = maxHeight + (lines.length - 1) * lineHeightPx
      // Variable anchor (Mapbox `text-variable-anchor`): runtime
      // tries each candidate during collision and picks the first
      // non-overlapping one. Single-anchor labels always have one
      // candidate. The full draw + bbox is computed per candidate
      // here; the post-collision phase below picks the chosen one.
      const candidates = p.def.anchorCandidates && p.def.anchorCandidates.length > 0
        ? p.def.anchorCandidates
        : [p.def.anchor ?? 'center']
      const padding = (p.def.padding ?? 2) * dpr
      const haloOut = p.def.halo
        ? {
            color: p.def.halo.color,
            width: p.def.halo.width * dpr,
            ...(p.def.halo.blur !== undefined ? { blur: p.def.halo.blur * dpr } : {}),
          }
        : undefined
      const layouts: Array<{ draw: TextDraw; bbox: typeof shaped[number]['bboxes'][number] }> = []
      for (const anchor of candidates) {
        let dx = 0, dy = 0
        if (anchor === 'left' || anchor.endsWith('-left')) dx = 0
        else if (anchor === 'right' || anchor.endsWith('-right')) dx = -totalAdvance
        else dx = -totalAdvance / 2
        if (anchor === 'top' || anchor.startsWith('top-')) dy = totalHeight
        else if (anchor === 'bottom' || anchor.startsWith('bottom-')) dy = 0
        else dy = totalHeight / 2
        if (p.def.offset) {
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
        const glyphOffsets = lines.length > 1 ? new Float32Array(glyphs.length * 2) : undefined
        if (glyphOffsets) {
          // text-justify: auto resolves per anchor — left-anchors →
          // left, right-anchors → right, else center.
          const isLeftAnchor = anchor === 'left' || anchor.endsWith('-left')
          const isRightAnchor = anchor === 'right' || anchor.endsWith('-right')
          const effectiveJustify = justify === 'auto'
            ? (isLeftAnchor ? 'left' : isRightAnchor ? 'right' : 'center')
            : justify
          for (let li = 0; li < lines.length; li++) {
            const ln = lines[li]!
            let lineX = 0
            if (effectiveJustify === 'right') lineX = totalAdvance - ln.width
            else if (effectiveJustify === 'left') lineX = 0
            else lineX = (totalAdvance - ln.width) * 0.5
            const lineY = -totalHeight + maxHeight + li * lineHeightPx
            let pen = lineX
            for (let gi = ln.start; gi < ln.end; gi++) {
              glyphOffsets[gi * 2] = drawX - p.anchorX + pen
              glyphOffsets[gi * 2 + 1] = drawY - p.anchorY + lineY
              pen += advances[gi]!
              if (gi < ln.end - 1) pen += letterSpacingPx
            }
          }
        }
        const bbox = {
          minX: drawX - padding,
          minY: drawY - totalHeight - padding,
          maxX: drawX + totalAdvance + padding,
          maxY: drawY + padding,
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
      }
      shaped.push({
        layouts,
        allowOverlap: p.def.allowOverlap === true,
        ignorePlacement: p.def.ignorePlacement === true,
      })
    }

    // Phase 1b: shape curved line labels. Each glyph rides a
    // different point on the polyline with the local tangent rotation.
    // The static bbox used for collision is the AABB of all glyph
    // centres (rough but cheap; precise oriented bboxes are overkill
    // for label-vs-label dedupe at typical zoom).
    for (const p of this.pendingLine) {
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      if (glyphs.length === 0) continue
      const sizePx = p.def.size * dpr
      const scale = sizePx / this.opts.rasterFontSize
      const letterSpacingPx = (p.def.letterSpacing ?? 0) * sizePx
      // Total label width along the polyline (sum of advances + spacing).
      let totalAdvancePx = 0
      const advances: number[] = new Array(glyphs.length)
      for (let gi = 0; gi < glyphs.length; gi++) {
        const adv = glyphs[gi]!.advanceWidth * scale
        advances[gi] = adv
        totalAdvancePx += adv
      }
      totalAdvancePx += letterSpacingPx * Math.max(0, glyphs.length - 1)
      // Cumulative polyline length + per-vertex distance for fast
      // distance-to-position lookup.
      const px = p.polylineX, py = p.polylineY
      const n = px.length
      if (n < 2) continue
      const cumLen: number[] = new Array(n)
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

      // Sample point at distance `s` along the polyline. When
      // walkReversed, distances are measured from the polyline END
      // (so `s=0` ⇒ the last vertex). The angle is flipped 180° so
      // glyphs face the new "forward" (= original-backward) direction.
      let segIdx = 0
      const sampleAt = (s: number): { x: number; y: number; angle: number } => {
        const sFwd = walkReversed ? totalLineLen - s : s
        while (segIdx < n - 2 && cumLen[segIdx + 1]! < sFwd) segIdx++
        // For reverse walk, snap segIdx back if we overshot (sFwd
        // monotonically decreases with each call when walkReversed).
        while (segIdx > 0 && cumLen[segIdx]! > sFwd) segIdx--
        const segLen = cumLen[segIdx + 1]! - cumLen[segIdx]!
        const t = segLen > 0 ? (sFwd - cumLen[segIdx]!) / segLen : 0
        const ax = px[segIdx]!, ay = py[segIdx]!
        const bx = px[segIdx + 1]!, by = py[segIdx + 1]!
        const x = ax + (bx - ax) * t
        const y = ay + (by - ay) * t
        let angle = Math.atan2(by - ay, bx - ax)
        if (walkReversed) angle += Math.PI
        return { x, y, angle }
      }
      const glyphOffsets = new Float32Array(glyphs.length * 2)
      const glyphRotations = new Float32Array(glyphs.length)
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
        const center = cursor + adv * 0.5
        const sample = sampleAt(center)
        // Perpendicular shift: rotate (0, verticalOffsetPx) by the
        // sample's tangent angle. cos/sin of (angle + 90°) =
        // (-sin angle, cos angle). Multiply by the desired offset.
        const perpX = -Math.sin(sample.angle) * verticalOffsetPx
        const perpY = Math.cos(sample.angle) * verticalOffsetPx
        glyphOffsets[gi * 2] = sample.x + perpX
        glyphOffsets[gi * 2 + 1] = sample.y + perpY
        glyphRotations[gi] = sample.angle
        if (sample.x < gminX) gminX = sample.x
        if (sample.x > gmaxX) gmaxX = sample.x
        if (sample.y < gminY) gminY = sample.y
        if (sample.y > gmaxY) gmaxY = sample.y
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
      })
    }

    // Phase 2: greedy bbox collision.
    //
    // Mapbox / MapLibre collision semantic: a label belonging to a
    // LATER layer in the style takes precedence over an earlier
    // layer's label when their bboxes overlap. The mental model is
    // "the layer you draw on top wins the screen real-estate
    // contest" — countries (last in OFM Bright) beat water_name
    // labels (first) at the antimeridian; POI labels (mid-stack)
    // beat road shields when they collide.
    //
    // Our `pending` queue is populated in style order — water first,
    // country last — because map.ts iterates showCommands forward.
    // greedyPlaceBboxes is first-wins, so a naïve forward call lets
    // water labels claim the bbox real-estate and drops the country
    // ones. That's the wrong precedence and visibly so on low-zoom
    // mobile views (multiple sea names crowd out country labels
    // around the antimeridian).
    //
    // Fix: iterate the collision input in REVERSE so later layers
    // place first. Draw order stays in original `shaped` order so
    // the layered rendering effect (country text on top of water
    // halo) is preserved — only the collision dedup priority flips.
    const collisionInput: CollisionItem[] = shaped.map(s => ({
      bboxes: s.layouts.map(l => l.bbox),
      allowOverlap: s.allowOverlap,
      ignorePlacement: s.ignorePlacement,
    }))
    const reversed: CollisionItem[] = []
    for (let i = collisionInput.length - 1; i >= 0; i--) reversed.push(collisionInput[i]!)
    const placementsReversed = greedyPlaceBboxes(reversed)
    // Map back to original index space so the draw loop below reads
    // the right placement per shaped[i].
    const placements: typeof placementsReversed = new Array(shaped.length)
    for (let i = 0; i < placementsReversed.length; i++) {
      placements[shaped.length - 1 - i] = placementsReversed[i]!
    }
    const draws: TextDraw[] = []
    for (let i = 0; i < shaped.length; i++) {
      const placement = placements[i]!
      if (placement.placed) draws.push(shaped[i]!.layouts[placement.chosen]!.draw)
    }

    // Flush dirty SDFs to GPU BEFORE setDraws — guarantees every
    // referenced glyph slot is resident when the renderer reads
    // page0.width to compute UVs.
    this.gpu.flush()
    this.renderer.setDraws(draws)
  }

  /** Encode the prepared draws onto the pass. Safe to call without
   *  a prior prepare() — emits nothing in that case. */
  render(pass: GPURenderPassEncoder, viewport: { width: number; height: number }): void {
    this.renderer.draw(pass, viewport)
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

