// Font loader — TTF/OTF → glyph SVG paths.
//
// Strategy: parse the font with opentype.js, extract each requested
// glyph's outline as an SVG path d-string, and hand it to the
// existing `ShapeRegistry` (sdf-shape.ts). Each glyph becomes a
// registered "shape" (e.g. `glyph:OpenSans:65` for the letter 'A')
// that the point renderer can draw as a positioned billboard.
//
// Why no glyph atlas: X-GIS already has an SDF shape system with
// per-fragment SDF computation from storage-buffered Bézier
// segments (sdf-shape.ts). Reusing it for text saves us building
// + maintaining an atlas, glyph-cache invalidation, and atlas-
// packing — at the cost of slightly more fragment work per glyph
// (the atlas would be 2-3 ALU ops, ours is ~10 ops per Bézier
// segment per fragment). For small/medium label loads (< 1000
// glyphs visible) this is fine; if perf becomes an issue we can
// add an atlas as an optimisation.
//
// Mapbox compatibility: this loader handles direct .ttf / .otf
// URLs. Mapbox's glyph PBF format (`/glyphs/{fontstack}/{range}.pbf`)
// is a future addition for importing protomaps / Mapbox tile servers
// that already publish glyph PBFs.

import opentype from 'opentype.js'

/** Per-font cached glyph data — paths + advance metrics. */
export interface FontData {
  /** Stable key under which this font is registered with the
   *  ShapeRegistry. Glyphs are addressed as `glyph:${key}:${cp}`. */
  key: string
  /** opentype.js Font object — kept around so consumers can request
   *  glyphs lazily (without re-fetching). */
  font: opentype.Font
  /** Font units per EM. Used by callers to normalise advance widths
   *  to a "size 1.0" coordinate frame (multiply by desired font size
   *  to get pixels). */
  unitsPerEm: number
  /** Ascender + descender in font units. Useful for line height
   *  calculation. */
  ascender: number
  descender: number
}

/** Single-glyph payload returned by `extractGlyph`. */
export interface GlyphData {
  /** SVG path d-string in opentype's coordinate frame (font units,
   *  Y-up at baseline). The ShapeRegistry's SVG path parser handles
   *  this directly. */
  pathData: string
  /** Horizontal cursor advance after rendering this glyph, in font
   *  units. Layout uses this to position the next glyph. */
  advanceWidth: number
  /** Left bearing — extra space before the visible part of the
   *  glyph. Layout adds this to the cursor before drawing. */
  leftSideBearing: number
  /** Glyph bounding box in font units. Useful for collision tests. */
  bbox: { xMin: number; yMin: number; xMax: number; yMax: number } | null
}

const fontCache = new Map<string, Promise<FontData>>()

/** Load a font from a URL and cache it under `key`. Repeated calls
 *  with the same URL share the same Promise (no double fetch).
 *
 *  `key` is the name the font registers under in the ShapeRegistry.
 *  Mapbox styles use it via `text-font: ["Open Sans Regular"]` →
 *  `key = "Open Sans Regular"`. Pass a stable identifier; the
 *  ShapeRegistry uses it to disambiguate glyphs from different
 *  fonts that share codepoints. */
export async function loadFont(url: string, key: string): Promise<FontData> {
  const cached = fontCache.get(key)
  if (cached) return cached

  const promise = (async (): Promise<FontData> => {
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(`[font-loader] ${url} returned HTTP ${resp.status}`)
    }
    const buf = await resp.arrayBuffer()
    const font = opentype.parse(buf)
    return {
      key,
      font,
      unitsPerEm: font.unitsPerEm,
      ascender: font.ascender,
      descender: font.descender,
    }
  })()

  promise.catch(() => fontCache.delete(key))
  fontCache.set(key, promise)
  return promise
}

/** Extract a single glyph from a loaded font as an SVG path + metrics.
 *  Returns null if the codepoint is unmapped (charToGlyph returns
 *  the `.notdef` fallback) AND the caller didn't explicitly ask for
 *  codepoint 0. Whitespace glyphs (' ', \t) often have valid metrics
 *  but no path; they return a non-null GlyphData with
 *  `pathData === ''`. */
export function extractGlyph(font: FontData, codepoint: number): GlyphData | null {
  // hasChar is the explicit "is this codepoint mapped?" signal.
  // `charToGlyph` falls back to .notdef silently, so we'd otherwise
  // return junk for unmapped chars.
  if (typeof font.font.hasChar === 'function' && !font.font.hasChar(String.fromCodePoint(codepoint))) {
    return null
  }
  const glyph = font.font.charToGlyph(String.fromCodePoint(codepoint))
  // Belt-and-suspenders: opentype.js sometimes lacks a hasChar
  // method on hand-built fonts. If charToGlyph returned .notdef
  // (index 0) and we didn't ask for codepoint 0, treat as unmapped.
  if (typeof font.font.hasChar !== 'function' && glyph.index === 0 && codepoint !== 0) {
    return null
  }

  // opentype's Glyph#getPath returns a Path object with `toPathData()`
  // for SVG d-string. The path is in the font's coordinate frame —
  // x = horizontal advance, y = baseline (Y-down screen coords after
  // opentype's flip).
  // Pass scale=1, x=0, y=0 — ShapeRegistry consumers normalise.
  const path = glyph.getPath(0, 0, 1)
  const pathData = path.toPathData(2) // 2 decimal places — sub-unit precision sufficient

  // Bounding box may be undefined for empty glyphs (e.g. space).
  let bbox: GlyphData['bbox'] = null
  if (typeof glyph.getBoundingBox === 'function') {
    const bb = glyph.getBoundingBox()
    if (bb && Number.isFinite(bb.x1)) {
      bbox = { xMin: bb.x1, yMin: bb.y1, xMax: bb.x2, yMax: bb.y2 }
    }
  }

  return {
    pathData,
    advanceWidth: glyph.advanceWidth ?? 0,
    leftSideBearing: glyph.leftSideBearing ?? 0,
    bbox,
  }
}

/** Compute the shape-registry name for a glyph. Stable across calls
 *  so the registry's dedup catches re-registration. Used by both
 *  the registration path and the per-feature lookup at draw time. */
export function glyphShapeName(fontKey: string, codepoint: number): string {
  return `glyph:${fontKey}:${codepoint}`
}

/** Clear the in-memory font cache. Test-only; production code should
 *  let the cache live for the session. */
export function clearFontCache(): void {
  fontCache.clear()
}
