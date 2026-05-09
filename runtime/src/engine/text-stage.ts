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

const DEFAULTS: Required<Omit<TextStageOptions, 'rasterizer'>> = {
  slotSize: 32,
  pageSize: 2048,
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
      fontKey: fontKey ?? def.font?.[0] ?? this.opts.defaultFont,
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
      draw: TextDraw
      bbox: { minX: number; minY: number; maxX: number; maxY: number }
      allowOverlap: boolean
      ignorePlacement: boolean
    }
    const shaped: ShapedLabel[] = []
    for (const p of this.pending) {
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      // letter-spacing in em units (Mapbox convention) — multiplies
      // the display font size to produce extra px between adjacent
      // glyphs. Applied as a per-glyph advance bump that the
      // text-renderer reads via the glyph's effective advance.
      const letterSpacingPx = (p.def.letterSpacing ?? 0) * p.def.size
      const scale = p.def.size / this.opts.rasterFontSize
      // Multiline layout: greedy word-break at maxWidth (em-units →
      // px). When unset, treat as Infinity = single line.
      const maxWidthPx = p.def.maxWidth !== undefined
        ? p.def.maxWidth * p.def.size : Infinity
      const lineHeightEm = p.def.lineHeight ?? 1.2
      const lineHeightPx = lineHeightEm * p.def.size
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
      const anchor = p.def.anchor ?? 'center'
      let dx = 0, dy = 0
      if (anchor === 'left' || anchor.endsWith('-left')) dx = 0
      else if (anchor === 'right' || anchor.endsWith('-right')) dx = -totalAdvance
      else dx = -totalAdvance / 2
      if (anchor === 'top' || anchor.startsWith('top-')) dy = totalHeight
      else if (anchor === 'bottom' || anchor.startsWith('bottom-')) dy = 0
      else dy = totalHeight / 2
      if (p.def.offset) {
        dx += p.def.offset[0] * p.def.size
        dy += p.def.offset[1] * p.def.size
      }
      const drawX = p.anchorX + dx
      const drawY = p.anchorY + dy
      // Compute per-glyph offsets relative to (drawX, drawY) for
      // multi-line layout. Each line gets justified within the
      // bbox according to `justify`; lines stack vertically by
      // lineHeightPx.
      const glyphOffsets = lines.length > 1 ? new Float32Array(glyphs.length * 2) : undefined
      if (glyphOffsets) {
        for (let li = 0; li < lines.length; li++) {
          const ln = lines[li]!
          // Horizontal offset within the bbox per justify mode.
          let lineX = 0
          if (justify === 'right') lineX = totalAdvance - ln.width
          else if (justify === 'left' || (justify === 'auto' && (anchor === 'left' || anchor.endsWith('-left')))) {
            lineX = 0
          } else lineX = (totalAdvance - ln.width) * 0.5
          // Vertical: line `li` sits lineHeightPx*li below the first.
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
      const padding = (p.def.padding ?? 2)
      const bbox = {
        minX: drawX - padding,
        minY: drawY - totalHeight - padding,
        maxX: drawX + totalAdvance + padding,
        maxY: drawY + padding,
      }
      shaped.push({
        draw: {
          anchorX: drawX,
          anchorY: drawY,
          glyphs,
          fontSize: p.def.size,
          rasterFontSize: this.opts.rasterFontSize,
          color: p.def.color ?? [0, 0, 0, 1],
          halo: p.def.halo,
          letterSpacingPx,
          rotateRad: p.def.rotate ? p.def.rotate * Math.PI / 180 : undefined,
          glyphOffsets,
        },
        bbox,
        allowOverlap: p.def.allowOverlap === true,
        ignorePlacement: p.def.ignorePlacement === true,
      })
    }

    // Phase 2: greedy bbox collision. Iterate in INPUT order (which
    // is the per-frame queue order — typically the order the data
    // source returned features). Skip a label whose bbox overlaps
    // an already-placed label's bbox unless the label opts out via
    // `label-allow-overlap`. `label-ignore-placement` keeps a label
    // visible AND prevents it from blocking later labels (matches
    // Mapbox semantics).
    const placedBlocking: typeof shaped[number]['bbox'][] = []
    const draws: TextDraw[] = []
    for (const s of shaped) {
      let collides = false
      if (!s.allowOverlap) {
        for (const placed of placedBlocking) {
          if (s.bbox.minX < placed.maxX && s.bbox.maxX > placed.minX
              && s.bbox.minY < placed.maxY && s.bbox.maxY > placed.minY) {
            collides = true
            break
          }
        }
      }
      if (collides) continue
      draws.push(s.draw)
      if (!s.ignorePlacement) placedBlocking.push(s.bbox)
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
