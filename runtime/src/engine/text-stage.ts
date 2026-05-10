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
import { TextRenderer, type TextDraw } from './text-renderer'
import { greedyPlaceBboxes, type CollisionItem } from './text-collision'

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
}

// Slot must fit (rasterFontSize + 2*sdfRadius) — ascenders/descenders
// of a 24-px raster font extend ~28-30 px, plus 6 px SDF radius on
// each side ⇒ 40-42 px needed. Round to 48 for some headroom on
// CJK/diacritics. The previous 32 default clipped both descenders and
// the SDF falloff, producing visible halo cutoffs.
const DEFAULTS: Required<Omit<TextStageOptions, 'rasterizer'>> = {
  slotSize: 48,
  pageSize: 2304,
  rasterFontSize: 24,
  sdfRadius: 6,
  defaultFont: 'sans-serif',
}

interface PendingLabel {
  text: string
  anchorX: number
  anchorY: number
  def: LabelDef
  fontKey: string
}

export class TextStage {
  readonly host: GlyphAtlasHost
  readonly gpu: GlyphAtlasGPU
  readonly renderer: TextRenderer
  readonly opts: Required<Omit<TextStageOptions, 'rasterizer'>>
  private readonly pending: PendingLabel[] = []
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
    this.opts = { ...DEFAULTS, ...options } as Required<Omit<TextStageOptions, 'rasterizer'>>
    const rasterizer = options.rasterizer ?? createRasterizer()
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

  /** Default prewarm set: '0'..'9', '.,:;-+°\'\"NSEW '. Covers
   *  cursor coord readouts, timestamps, distance/bearing labels. */
  prewarmGISDefaults(fontKey?: string): void {
    const set: number[] = []
    for (let c = 0x20; c <= 0x7E; c++) set.push(c)  // basic Latin
    set.push(0xB0)  // °
    this.prewarm(set, fontKey)
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
  ): void {
    const text = resolveText(value, props)
    if (text.length === 0) return
    const transformed = applyTextTransform(text, def.transform)
    this.pending.push({
      text: transformed,
      anchorX: anchorScreenX,
      anchorY: anchorScreenY,
      def,
      // font stack → comma-separated CSS font value. The browser's
      // ctx.font parser walks the stack glyph-by-glyph. Names with
      // spaces are quoted to avoid the parser ambiguating them as
      // separate entries.
      fontKey: fontKey ?? (def.font && def.font.length > 0
        ? def.font.map(f => f.includes(' ') ? `"${f}"` : f).join(',')
        : this.opts.defaultFont),
    })
  }

  /** Realize queued labels into atlas + GPU + draw list. Caller
   *  invokes this once per frame after all addLabel() calls and
   *  before encoding the render pass; render() then encodes the
   *  draws onto the supplied pass. */
  prepare(): void {
    if (this.pending.length === 0) {
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
        // Track break candidates at U+0020 (space).
        if (g.codepoint === 0x20) {
          lastSpaceI = gi
          lastSpaceW = lineW
        }
        if (lineW + adv > maxWidthPx && lastSpaceI > lineStart) {
          // Wrap at the most recent space. The space itself is
          // dropped (it would otherwise sit at the end of the line).
          lines.push({ start: lineStart, end: lastSpaceI, width: lastSpaceW })
          lineStart = lastSpaceI + 1
          lineW = 0
          for (let j = lineStart; j <= gi; j++) {
            lineW += advances[j]!
            if (j < gi) lineW += letterSpacingPx
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

    // Phase 2: greedy bbox collision with per-label candidate fallback.
    // Input order is the per-frame queue order (= feature order from
    // the source). See text-collision.ts for the algorithm.
    const collisionInput: CollisionItem[] = shaped.map(s => ({
      bboxes: s.layouts.map(l => l.bbox),
      allowOverlap: s.allowOverlap,
      ignorePlacement: s.ignorePlacement,
    }))
    const placements = greedyPlaceBboxes(collisionInput)
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
  }

  destroy(): void {
    this.renderer.destroy()
    this.gpu.destroy()
  }
}

/** Mapbox `text-transform` — uppercase / lowercase / none.
 *  Note for CJK: case mapping is undefined for ideographs and
 *  hangul — Unicode default-cased mappings just pass them through. */
function applyTextTransform(s: string, t?: 'none' | 'uppercase' | 'lowercase'): string {
  if (t === 'uppercase') return s.toUpperCase()
  if (t === 'lowercase') return s.toLowerCase()
  return s
}
