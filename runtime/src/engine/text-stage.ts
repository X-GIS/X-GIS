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
    const draws: TextDraw[] = []
    for (const p of this.pending) {
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      draws.push({
        anchorX: p.anchorX,
        anchorY: p.anchorY,
        glyphs,
        fontSize: p.def.size,
        rasterFontSize: this.opts.rasterFontSize,
        color: p.def.color ?? [0, 0, 0, 1],
        halo: p.def.halo,
      })
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
