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
} from '@xgis/map'
import { parseFontKey, parseSizedFontKey } from '@xgis/map'
import type { GlyphProvider } from '@xgis/map'
import { pbfGlyphToSlot, PBF_REF_SIZE } from '@xgis/map'

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

// CJK fallback chain marker — composeFontKey appends a fixed CSS family
// list AFTER the user-specified families so Canvas2D can hit OS Han /
// Hangul glyphs. The PBF server doesn't recognise these CSS-only
// families, so we strip them when deriving the fontstack name. The
// marker is the first known CJK entry; the boundary is deterministic
// because composeFontKey controls the chain.
const CJK_CHAIN_MARKERS = [
  '"Noto Sans CJK KR"', 'Noto Sans CJK KR',
]

/** Split the family list from a composeFontKey output into user-
 *  specified families (the ones the style author asked for) and the
 *  CJK fallback chain (engine-injected). Pure helper exported for
 *  unit testing. */
export function splitUserFamilies(familyList: string): string[] {
  let userPortion = familyList
  for (const marker of CJK_CHAIN_MARKERS) {
    const idx = familyList.indexOf(marker)
    if (idx >= 0) { userPortion = familyList.slice(0, idx); break }
  }
  return userPortion
    .replace(/,\s*$/, '')
    .split(',')
    .map(f => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** Reconstruct the PBF fontstack name from a runtime fontKey. Exported
 *  for unit testing.
 *
 *  Mapbox/MapLibre naming convention has a quirk: when a style asks
 *  for `text-font: ["Noto Sans Italic"]`, the glyph server ships that
 *  exact stack name — NOT "Noto Sans Regular Italic". So default-
 *  weight + italic omits the explicit "Regular" token. Every other
 *  combination keeps the weight: "Noto Sans Bold", "Noto Sans Bold
 *  Italic", "Open Sans Semibold". Pre-fix bug: OFM Bright label
 *  layers using "Noto Sans Italic" all 404'd on the PBF fetch and
 *  silently dropped back to Canvas2D font synthesis — visible as
 *  italic Latin labels drawn from a synthesised oblique of the
 *  bundled wght-only Variable WOFF2 + CJK glyphs falling through to
 *  the OS Malgun Gothic / Apple SD Gothic Neo (visibly different
 *  letterforms than the OFM-served Noto Sans Italic Korean). */
export function deriveFontstack(fontKey: string): string {
  const { style, weight, family } = parseFontKey(fontKey)
  // Pick the first user-specified family. Multi-entry text-font
  // (text-font: ["Noto Sans", "Arial Unicode MS"]) is rare among the
  // styles we support today (OFM, MapLibre demo: all single-entry),
  // AND tested glyph servers (OFM, Demotiles) don't support a comma-
  // joined fontstack URL — they 404. Proper multi-stack support
  // requires client-side multi-fetch (one URL per fontstack, per-
  // codepoint priority resolution); deferred to Phase 2 until a
  // real style needs it.
  const firstFamily = splitUserFamilies(family)[0] ?? family.split(',')[0]!.trim().replace(/^["']|["']$/g, '')
  const weightNum = parseInt(weight, 10) || 400
  const isItalic = style === 'italic' || style === 'oblique'
  let token: string
  if (weightNum === 400 && isItalic) {
    token = 'Italic'                                          // "Noto Sans Italic"
  } else if (weightNum === 400) {
    token = 'Regular'                                         // "Noto Sans Regular"
  } else {
    const w = WEIGHT_TO_KEYWORD[weightNum] ?? 'Regular'
    token = isItalic ? `${w} Italic` : w                      // "... Bold Italic" / "... Bold"
  }
  return `${firstFamily} ${token}`
}

export interface PbfRasterizerDeps {
  fallback: GlyphRasterizer
  /** Full Canvas2D rasterizer used for LOCAL-IDEOGRAPH glyphs (#421): a
   *  size-marked fontKey (see cjkSizedFontKey) is rendered here at its
   *  display-size bucket via the OS CJK face — matching MapLibre's
   *  localIdeographFontFamily — instead of fetched from the PBF server at the
   *  fixed 24-px reference (which minifies into a box at small sizes). Unlike
   *  `fallback` (metrics-only, zero SDF), this is the FULL Canvas2D path so the
   *  glyph is the PRIMARY render, not a placeholder awaiting a PBF that never
   *  comes. Defaults to `fallback` when omitted (legacy: CJK via PBF). */
  cjkFull?: GlyphRasterizer
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
  private readonly cjkFull: GlyphRasterizer
  private readonly providers: GlyphProvider[]
  private readonly onLanded: (fontKey: string, codepoint: number) => void

  constructor(deps: PbfRasterizerDeps) {
    this.fallback = deps.fallback
    this.cjkFull = deps.cjkFull ?? deps.fallback
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
    // Local-ideograph (#421): a size-marked fontKey is a CJK glyph the text
    // stage wants rendered at its display size. Skip the PBF server entirely
    // (its fixed-24 SDF minifies to a box at small sizes) and rasterise it
    // locally at the bucket via the full Canvas2D path. The marker is only
    // ever attached to ideograph codepoints, so this never diverts Latin.
    if (parseSizedFontKey(req.fontKey).sizePx !== null) {
      return this.cjkFull.rasterize(req)
    }

    const fontstack = deriveFontstack(req.fontKey)

    // 1. Sync probe — first hit wins.
    for (const p of this.providers) {
      const g = p.get(fontstack, req.codepoint)
      if (g) {
        // PBF-server SDF: byte slope matches the renderer's `·3` halo
        // constant. Tag it so packUniforms keeps that path unchanged
        // (locally-rasterised fallbacks below stay untagged → the
        // SDF-consistent halo normalisation applies to them instead).
        const slot = pbfGlyphToSlot(g, req.fontKey, req.slotSize, req.sdfRadius, req.fontSize)
        // bearingY (= PBF `top`) convention fix. Some OFM fontstacks bake
        // LATIN glyphs with `top` relative to the font ASCENDER line
        // (→ NEGATIVE) while CJK is baseline-relative (→ positive). The
        // baseline-relative setDraws placement (`y0 = baseline -
        // bearingY*scale`) reads a negative bearingY as "ink below the
        // baseline", dropping the latin line into the CJK line below →
        // the user-reported bilingual vertical collapse (2026-05-22,
        // /debug-labels.html: "Fuxing\n复兴镇 복흥진" line-2 over line-1).
        // A printing glyph (ink height > 0) can NEVER have a negative
        // baseline-ascent, so a negative bearingY is the convention tell.
        // Recover the TRUE ascent from the Canvas2D fallback's
        // actualBoundingBoxAscent (real per-font metric — no hardcoded
        // ascender constant), rescaled to the PBF 24-px reference. Runs
        // once per glyph (atlas-cached), latin-only.
        if (slot.bearingY < 0 && req.fontSize > 0) {
          const m = this.fallback.rasterize(req)
          if (m.advanceWidth > 0 && m.bearingY > 0) {
            slot.bearingY = m.bearingY * (PBF_REF_SIZE / req.fontSize)
          }
        }
        return { ...slot, pbf: true }
      }
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
