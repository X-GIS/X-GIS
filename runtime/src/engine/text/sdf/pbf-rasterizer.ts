// Wraps a fallback (typically Canvas2DRasterizer) with a chain of
// GlyphProvider implementations. The interface stays synchronous:
// the first provider whose sync `get()` hits wins; if no provider has
// the glyph yet, every `ensure()`-capable provider gets a chance to
// schedule a background load AND the fallback rasterizer runs so the
// frame doesn't blank. When any provider lands the glyph,
// `onLanded(fontKey, codepoint)` invalidates the atlas slot — the
// next prepare() re-rasterises through this chain and now hits the
// fresh data, silently upgrading the visual.
//
// Provider order is meaningful: cheapest source first. A typical
// "online-or-offline" setup is `[InlineGlyphProvider, GlyphPbfCache]`
// — inline data wins instantly with zero network; HTTP only fires
// for codepoints the host didn't pre-bundle.

import type {
  GlyphRasterizer, GlyphRasterRequest, GlyphRasterResult,
} from './glyph-rasterizer'
import { parseFontKey } from './glyph-rasterizer'
import type { GlyphProvider } from './pbf/glyph-provider'
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
  /** Ordered chain of glyph sources. Walked left-to-right per glyph;
   *  the first sync hit wins. Adding a provider later via
   *  `addProvider()` appends to the chain. */
  providers: GlyphProvider[]
  /** Called after one of the chain's `ensure()` resolves AND now has
   *  the awaited codepoint in `get()`. The atlas-host invalidates the
   *  slot so the next frame re-rasterises through the chain. */
  onLanded: (fontKey: string, codepoint: number) => void
}

export class PbfRasterizer implements GlyphRasterizer {
  private readonly fallback: GlyphRasterizer
  private readonly providers: GlyphProvider[]
  private readonly onLanded: (fontKey: string, codepoint: number) => void

  constructor(deps: PbfRasterizerDeps) {
    this.fallback = deps.fallback
    // Defensive copy — caller's array can still be mutated, but our
    // walking-order isn't affected by their later splices.
    this.providers = [...deps.providers]
    this.onLanded = deps.onLanded
  }

  /** Append a provider to the end of the chain. Visible to subsequent
   *  `rasterize()` calls; in-flight `ensure()`-scheduled invalidations
   *  from earlier providers fire normally. Used by `XGISMap.addGlyph
   *  Provider` for runtime composition. */
  addProvider(p: GlyphProvider): void {
    this.providers.push(p)
  }

  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    const fontstack = deriveFontstack(req.fontKey)

    // 1. Sync probe — first hit wins.
    for (const p of this.providers) {
      const g = p.get(fontstack, req.codepoint)
      if (g) return pbfGlyphToSlot(g, req.fontKey, req.slotSize, req.sdfRadius, req.fontSize)
    }

    // 2. No hit yet — let every async-capable provider schedule a load.
    //    Their `ensure` is idempotent so calling each one repeatedly is
    //    safe; whichever wins the race lands its data first and fires
    //    `onLanded`. The re-check inside the callback guards against
    //    a provider that resolves its range but the codepoint isn't
    //    present (e.g. range 0-255 has 'A' but not 0x00).
    const { fontKey, codepoint } = req
    for (const p of this.providers) {
      if (!p.ensure) continue
      p.ensure(fontstack, codepoint, () => {
        if (p.get(fontstack, codepoint)) this.onLanded(fontKey, codepoint)
      })
    }

    // 3. Fall back to the Canvas2D / system path so this frame draws.
    return this.fallback.rasterize(req)
  }
}
