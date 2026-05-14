// Wraps a fallback (typically Canvas2DRasterizer) with a PBF-glyph
// cache. The interface stays synchronous: cache-hit returns the PBF
// SDF, cache-miss returns the fallback immediately AND schedules a
// background fetch. When the fetch lands, `onLanded(fontKey, codepoint)`
// is invoked so the atlas host can mark the slot for re-rasterise on
// the next frame — at which point this rasterizer will hit the now-
// warm cache and emit the PBF SDF, upgrading the visual silently.

import type {
  GlyphRasterizer, GlyphRasterRequest, GlyphRasterResult,
} from './glyph-rasterizer'
import { parseFontKey } from './glyph-rasterizer'
import { GlyphPbfCache } from './pbf/glyph-pbf-cache'
import { pbfGlyphToSlot } from './pbf/pbf-to-slot'

// CSS-weight number → MapLibre fontstack-name keyword. MapLibre's
// glyphs-server URL convention concatenates the family + weight keyword
// + optional " Italic" (e.g. "Open Sans Semibold", "Noto Sans Bold
// Italic"). We reverse our `parseFontKey` output to reconstruct that.
const WEIGHT_TO_KEYWORD: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
}

/** Reconstruct the PBF fontstack name from a runtime fontKey. Exported
 *  for unit testing. */
export function deriveFontstack(fontKey: string): string {
  const { style, weight, family } = parseFontKey(fontKey)
  // The family field may be a comma-separated CSS list (the engine
  // appends a CJK fallback chain). Take the first entry as the PBF
  // fontstack root — Mapbox styles always put the intended primary
  // family first.
  const firstFamily = family.split(',')[0]!.trim().replace(/^["']|["']$/g, '')
  const weightNum = parseInt(weight, 10) || 400
  const weightKw = WEIGHT_TO_KEYWORD[weightNum] ?? 'Regular'
  const styleKw = style === 'italic' || style === 'oblique' ? ' Italic' : ''
  return `${firstFamily} ${weightKw}${styleKw}`
}

export interface PbfRasterizerDeps {
  fallback: GlyphRasterizer
  cache: GlyphPbfCache
  /** Called after a PBF range fetch resolves and contains the awaited
   *  codepoint. The atlas-host invalidates the slot so the next frame
   *  re-rasterises via this rasterizer's cache-hit path. */
  onLanded: (fontKey: string, codepoint: number) => void
}

export class PbfRasterizer implements GlyphRasterizer {
  private readonly fallback: GlyphRasterizer
  private readonly cache: GlyphPbfCache
  private readonly onLanded: (fontKey: string, codepoint: number) => void

  constructor(deps: PbfRasterizerDeps) {
    this.fallback = deps.fallback
    this.cache = deps.cache
    this.onLanded = deps.onLanded
  }

  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    const fontstack = deriveFontstack(req.fontKey)
    const g = this.cache.get(fontstack, req.codepoint)
    if (g) {
      return pbfGlyphToSlot(g, req.fontKey, req.slotSize, req.sdfRadius, req.fontSize)
    }
    if (!this.cache.isResolved(fontstack, req.codepoint)) {
      const { fontKey, codepoint } = req
      this.cache.ensureRange(fontstack, codepoint, () => {
        // Re-check: the PBF might not actually contain this specific
        // codepoint (e.g. range 0-255 covers Latin but glyph 0x00 is
        // typically absent). Only invalidate when there's a real
        // upgrade to apply — otherwise the next frame would fall back
        // again and we'd loop.
        if (this.cache.get(fontstack, codepoint)) this.onLanded(fontKey, codepoint)
      })
    }
    return this.fallback.rasterize(req)
  }
}
