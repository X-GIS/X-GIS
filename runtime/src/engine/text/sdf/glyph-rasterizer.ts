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

/** Sentinel prefix that marks a fontKey as carrying weight/style.
 *
 *  Format: `<SENTINEL><style><SENTINEL><weight><SENTINEL><family-list>`.
 *  Plain family-list strings (no sentinel) keep the legacy code path
 *  (weight defaults to 400 / normal). Tucking the fields into the
 *  fontKey itself keeps the atlas cache key (`fontKey` opaque) doing
 *  the right thing for free — Regular and Bold of the same family
 *  hash to different slots without atlas-state needing to know they
 *  exist. \x01 (Start-of-Heading) is non-printable + can never appear
 *  in a real CSS font family name, so the split is unambiguous. */
export const FONT_KEY_SENTINEL = '\x01'

/** Unpack a fontKey produced by `composeFontKey` (text-stage.ts).
 *  Exported for the round-trip unit test only — production callers
 *  go through `rasterize()` which does the split internally. */
export function parseFontKey(fontKey: string): { style: string; weight: string; family: string } {
  if (!fontKey.startsWith(FONT_KEY_SENTINEL)) {
    return { style: 'normal', weight: '400', family: fontKey }
  }
  const parts = fontKey.split(FONT_KEY_SENTINEL)
  // After leading-sentinel split: ["", style, weight, family, ...]
  // Defensive defaults — a malformed key still rasterises rather than
  // throwing, which would blank an entire label layer at render time.
  return {
    style: parts[1] && parts[1].length > 0 ? parts[1] : 'normal',
    weight: parts[2] && parts[2].length > 0 ? parts[2] : '400',
    family: parts[3] ?? '',
  }
}

export interface GlyphRasterRequest {
  /** CSS-style font shorthand the Canvas2D ctx.font expects.
   *  E.g. "16px Noto Sans". The atlas key uses just `fontKey`
   *  (the family + style portion) so multiple display sizes
   *  share one rasterisation. May be either a plain family-list
   *  (legacy) or a sentinel-encoded `style|weight|family-list`
   *  produced by text-stage's composeFontKey — the rasterizer
   *  unpacks the latter into proper CSS shorthand. */
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
    // CSS font shorthand requires style/variant/weight/stretch BEFORE
    // size/family. Composing `${size}px ${fontKey}` only works when
    // fontKey is bare family; sentinel-encoded keys carry weight/style
    // that the browser would otherwise parse as part of the family
    // name (and silently fall back to the OS default font).
    const parsed = parseFontKey(fontKey)
    ctx.font = `${parsed.style} ${parsed.weight} ${fontSize}px ${parsed.family}`
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

// ─── Canvas2D metrics-only rasterizer (PBF placeholder) ──────────
//
// Sync metrics, zero SDF. Used as the PbfRasterizer fallback when a
// glyph server URL is configured: the assumption is "PBF will land
// in 50-200 ms and overwrite this entry via atlas.invalidate", so
// the right behaviour during the wait is to be FAST (don't freeze
// the frame) rather than to render a temporary Canvas2D-shaped
// glyph that gets immediately replaced.
//
// Cost profile vs the full Canvas2DRasterizer:
//   - full:    measureText + fillText + getImageData + computeSDF
//              → 8-15 ms / glyph at slotSize=64 (12-glyph cold frame
//              = 100-180 ms freeze, user-reported pan stutter).
//   - metrics: measureText only → ~0.05 ms / glyph (250-300× cheaper).
//
// Visual trade-off during the PBF fetch window: the glyph occupies
// its correct layout slot (metrics are accurate) but renders blank.
// As soon as the PBF range lands, `atlas.invalidate` marks the slot
// stale and the next ensure() call upgrades to the real SDF.
//
// Falls through to a full Canvas2D path when measureText returns
// zero advance — common for unsupported codepoints (emoji, rare CJK
// not in OFM PBF). Without the upgrade, those glyphs would stay
// blank forever; with it, we pay the one-time SDF cost only when
// PBF truly can't help.
export class Canvas2DMetricsRasterizer implements GlyphRasterizer {
  private readonly canvas: OffscreenCanvas | HTMLCanvasElement
  private readonly ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  private readonly fullFallback: GlyphRasterizer

  constructor(
    canvas: OffscreenCanvas | HTMLCanvasElement,
    fullFallback: GlyphRasterizer,
  ) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { willReadFrequently: false })
    if (!ctx) throw new Error('Canvas2DMetricsRasterizer: failed to acquire 2d context')
    this.ctx = ctx as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
    this.fullFallback = fullFallback
  }

  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    const { fontKey, fontSize, codepoint, sdfRadius, slotSize } = req
    const ctx = this.ctx
    // Minimal canvas — we never read pixels, only need a 2D context
    // to call measureText against. 1×1 is enough; resizing per slot
    // would be pointless.
    if (this.canvas.width !== 1) { this.canvas.width = 1; this.canvas.height = 1 }
    const parsed = parseFontKey(fontKey)
    ctx.font = `${parsed.style} ${parsed.weight} ${fontSize}px ${parsed.family}`
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    const ch = String.fromCodePoint(codepoint)
    const metrics = ctx.measureText(ch)
    // Unsupported codepoint (browser drew tofu but reported zero
    // metrics): bail to the full path so the user gets SOMETHING
    // even if PBF never delivers this character.
    if (metrics.width === 0) return this.fullFallback.rasterize(req)
    return {
      fontKey, codepoint, sdfRadius,
      sdf: new Uint8Array(slotSize * slotSize),  // all zeros = invisible
      advanceWidth: metrics.width,
      bearingX: -metrics.actualBoundingBoxLeft,
      bearingY: metrics.actualBoundingBoxAscent,
      width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
      height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
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

/** Companion to `createRasterizer` that wires a metrics-only fast
 *  rasterizer. Falls back to `fullFallback` on the same environment
 *  detection chain when an OffscreenCanvas / HTMLCanvas isn't
 *  available. */
export function createMetricsRasterizer(fullFallback: GlyphRasterizer): GlyphRasterizer {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new Canvas2DMetricsRasterizer(new OffscreenCanvas(1, 1), fullFallback)
    } catch { /* fall through */ }
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = 1; c.height = 1
    return new Canvas2DMetricsRasterizer(c, fullFallback)
  }
  return fullFallback
}
