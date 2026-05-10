// ═══════════════════════════════════════════════════════════════════
// Glyph Rasterizer (Batch 1c-6c)
// ═══════════════════════════════════════════════════════════════════
//
// Takes a `(fontKey, codepoint)` request and returns:
//   - the SDF bitmap for the glyph slot (Uint8Array)
//   - layout metrics (advance, bearing) for the text shaper
//
// Two execution paths:
//   - `Canvas2DRasterizer` — uses OffscreenCanvas / HTMLCanvasElement.
//     Lives here for the sync fallback path; the Worker file (1c-6d)
//     re-uses the Canvas2D implementation against an OffscreenCanvas
//     in worker scope.
//   - `MockRasterizer` — deterministic checkerboard SDF + fake metrics.
//     Used by unit tests (vitest has no Canvas2D) AND by the engine
//     when Canvas2D isn't available (SSR, headless without canvas
//     polyfill). Renders visible-but-recognisably-broken glyphs so
//     the user sees "something is wrong with fonts" instead of blank.
//
// Both implement the `GlyphRasterizer` interface so callers (the
// atlas + worker) treat them uniformly.

import { computeSDF } from './distance-transform'

export interface GlyphRasterRequest {
  /** CSS-style font shorthand the Canvas2D ctx.font expects.
   *  E.g. "16px Noto Sans". The atlas key uses just `fontKey`
   *  (the family + style portion) so multiple display sizes
   *  share one rasterisation. */
  fontKey: string
  /** Pixel size to rasterise at. The atlas typically uses one
   *  fixed size per font and lets the shader scale at draw time
   *  via SDF threshold smoothing. */
  fontSize: number
  /** Unicode codepoint to render. */
  codepoint: number
  /** SDF falloff in pixels. Determines how many pixels around the
   *  glyph edge encode anti-aliasing. */
  sdfRadius: number
  /** Output slot side length in pixels. Glyph is centered + clipped
   *  to fit. Caller's atlas decides this. */
  slotSize: number
}

export interface GlyphRasterResult {
  fontKey: string
  codepoint: number
  sdfRadius: number
  /** SDF bitmap, slotSize × slotSize, tiny-sdf packing
   *  (0 = far outside, 192 = edge, 255 = far inside). */
  sdf: Uint8Array
  /** Pixels to advance the pen after drawing this glyph. */
  advanceWidth: number
  /** Pen → glyph-bbox-left offset in pixels. */
  bearingX: number
  /** Baseline → glyph-bbox-top offset in pixels (positive up). */
  bearingY: number
  /** Glyph bounding-box width (px). */
  width: number
  /** Glyph bounding-box height (px). */
  height: number
}

export interface GlyphRasterizer {
  rasterize(req: GlyphRasterRequest): GlyphRasterResult
}

// ─── Canvas2D rasterizer ──────────────────────────────────────────

/** Rasterizes via Canvas2D. Works in main thread (HTMLCanvasElement)
 *  and worker (OffscreenCanvas) — both share the same 2D context API.
 *  Pass a canvas + ctx the constructor caches; per-glyph allocation
 *  is the alpha buffer + SDF buffer only. */
export class Canvas2DRasterizer implements GlyphRasterizer {
  private readonly canvas: OffscreenCanvas | HTMLCanvasElement
  private readonly ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

  constructor(canvas: OffscreenCanvas | HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas2DRasterizer: failed to acquire 2d context')
    // ctx is `OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D`
    // — both have the same surface used here (font, fillText, getImageData).
    this.ctx = ctx as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  }

  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    const { fontKey, fontSize, codepoint, sdfRadius, slotSize } = req
    const ctx = this.ctx

    if (this.canvas.width !== slotSize || this.canvas.height !== slotSize) {
      this.canvas.width = slotSize
      this.canvas.height = slotSize
    }

    ctx.clearRect(0, 0, slotSize, slotSize)
    ctx.fillStyle = '#000'
    ctx.font = `${fontSize}px ${fontKey}`
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'

    const ch = String.fromCodePoint(codepoint)
    const metrics = ctx.measureText(ch)
    const advanceWidth = metrics.width
    const bearingX = -metrics.actualBoundingBoxLeft
    const bearingY = metrics.actualBoundingBoxAscent
    const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
    const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent

    // Centre the glyph within the slot — leaves `sdfRadius` px of
    // padding on each side so the SDF falloff has room. Baseline
    // sits at `slotSize/2 + glyphHeight/2 - bearingY`.
    const drawX = (slotSize - width) / 2 - bearingX
    const drawY = (slotSize - height) / 2 + bearingY
    ctx.fillStyle = '#000'
    ctx.fillText(ch, drawX, drawY)

    // Pull alpha plane: Canvas2D fills RGBA; we just want the alpha.
    const img = ctx.getImageData(0, 0, slotSize, slotSize)
    const alpha = new Uint8Array(slotSize * slotSize)
    for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3]!

    const sdf = computeSDF(alpha, slotSize, slotSize, sdfRadius)

    return {
      fontKey, codepoint, sdfRadius, sdf,
      advanceWidth, bearingX, bearingY, width, height,
    }
  }
}

// ─── Mock rasterizer (tests + headless fallback) ───────────────────

/** Deterministic stand-in for environments without Canvas2D. Emits
 *  a SDF derived from the codepoint's bit pattern so tests can assert
 *  that DIFFERENT glyphs produce DIFFERENT atlas content (correctness
 *  of the dispatch path) without needing a real font. */
export class MockRasterizer implements GlyphRasterizer {
  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    const { fontKey, codepoint, sdfRadius, slotSize, fontSize } = req
    const alpha = new Uint8Array(slotSize * slotSize)
    // Fill with a codepoint-dependent disc so every glyph has a
    // distinct SDF without needing a real font.
    const cx = slotSize / 2
    const cy = slotSize / 2
    const r = (slotSize / 4) * (((codepoint % 8) + 4) / 8)
    for (let y = 0; y < slotSize; y++) {
      for (let x = 0; x < slotSize; x++) {
        const d = Math.hypot(x - cx, y - cy)
        alpha[y * slotSize + x] = d < r ? 255 : 0
      }
    }
    const sdf = computeSDF(alpha, slotSize, slotSize, sdfRadius)
    return {
      fontKey, codepoint, sdfRadius, sdf,
      advanceWidth: fontSize * 0.6,
      bearingX: 0,
      bearingY: fontSize * 0.7,
      width: fontSize * 0.6,
      height: fontSize,
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────

/** Build the best available rasterizer for the current environment.
 *  Worker scope: OffscreenCanvas. Main thread without OffscreenCanvas
 *  support: HTMLCanvasElement. Headless / SSR / vitest: MockRasterizer
 *  (visible-but-broken glyphs surface the env mismatch loudly). */
export function createRasterizer(): GlyphRasterizer {
  // Worker scope first — `self` exists in both window and worker but
  // OffscreenCanvas as a constructor is universally available where
  // Canvas2D-on-worker is supported.
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new Canvas2DRasterizer(new OffscreenCanvas(32, 32))
    } catch {
      // Some environments (older Safari) ship the constructor but
      // refuse `getContext('2d')` — fall through.
    }
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = 32; c.height = 32
    return new Canvas2DRasterizer(c)
  }
  return new MockRasterizer()
}
