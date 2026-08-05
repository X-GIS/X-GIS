// ═══ Which rasterizer a text stage gets, and what it falls back to ═══
//
// Three cases, decided once at stage construction:
//   1. `options.rasterizer` supplied                    → use it verbatim (tests, hosts)
//   2. `glyphsUrl` / `inlineGlyphs` / `glyphProviders`  → wrap Canvas2D in a PbfRasterizer
//                                                         chain
//   3. neither                                          → plain Canvas2D / Mock, the
//                                                         pre-PBF path, byte-identical
//
// Chain order is cheapest-source-first: `[InlineGlyphProvider, ...glyphProviders,
// GlyphPbfCache]`.
//
// THE TWO FALLBACKS ARE NOT INTERCHANGEABLE, and picking the wrong one is a shipped bug
// in both directions:
//
//  • `fallback` is METRICS-ONLY (measureText for layout, all-zero SDF). It exists because
//    the full Canvas2D path — fillText + getImageData + computeSDF — burns ~8 ms/glyph and
//    fires PER GLYPH on cold frames, accumulating into 100+ ms freezes on a dense label
//    scene during a rapid pan. Invisible-for-50-200 ms is the right trade WHILE the PBF
//    range is in flight, because `onLanded` upgrades the slot as soon as it arrives.
//  • `fullFallback` DRAWS. It is what a glyph gets once no PBF is coming — a permanently
//    failed range, or a codepoint the range simply lacks. `GlyphPbfCache` marks a failed
//    range terminal for the session, so routing that case to the placeholder made it the
//    FINAL answer: one blip on range 0-255 (all of Latin) left every label correctly
//    spaced and completely inkless, with no camera move recovering it (#1574).
//
// Extracted from text-stage.ts, which is a shrink-only god-file — this block is the whole
// of that decision and nothing else reads its locals.

import type { GlyphRasterizer } from './sdf/glyph-rasterizer'
import { createMetricsRasterizer, createRasterizer } from './sdf/glyph-rasterizer'
import { PbfRasterizer } from './sdf/pbf-rasterizer'
import type { GlyphProvider } from './sdf/pbf/glyph-provider'
import type { TextStageOptions } from './text-stage-types'
import { GlyphPbfCache } from './sdf/pbf/glyph-pbf-cache'
import { InlineGlyphProvider } from './sdf/pbf/inline-glyph-provider'

/** Build the stage's rasterizer. `pbf` is non-null only in case 2, and the caller keeps it
 *  so `addGlyphProvider` can extend the chain at runtime.
 *
 *  `onLanded` fires when a provider reaches a TERMINAL state for a codepoint — landed, or
 *  never coming. Both must invalidate the atlas slot: the first upgrades zero-SDF to the
 *  real SDF, the second replaces the placeholder with drawn letterforms. */
export function wireGlyphRasterizer(
  options: Pick<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders'>,
  onLanded: (fontKey: string, codepoint: number) => void,
): { rasterizer: GlyphRasterizer; pbf: PbfRasterizer | null } {
  if (options.rasterizer) return { rasterizer: options.rasterizer, pbf: null }
  if (!options.glyphsUrl && !options.inlineGlyphs && !options.glyphProviders)
    return { rasterizer: createRasterizer(), pbf: null }

  const fullFallback = createRasterizer()
  const providers: GlyphProvider[] = []
  if (options.inlineGlyphs) providers.push(new InlineGlyphProvider(options.inlineGlyphs))
  if (options.glyphProviders) providers.push(...options.glyphProviders)
  if (options.glyphsUrl) providers.push(new GlyphPbfCache({ glyphsUrl: options.glyphsUrl }))
  const pbf = new PbfRasterizer({
    fallback: createMetricsRasterizer(fullFallback),
    providers,
    // Local-ideograph (#421): bucketed CJK renders via the FULL Canvas2D path, because a
    // fixed-24 PBF SDF minifies to a box at small display sizes.
    cjkFull: fullFallback,
    fullFallback,
    onLanded,
  })
  return { rasterizer: pbf, pbf }
}
