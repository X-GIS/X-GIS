// ═══ Inline-image marker (Mapbox `["image", …]` in a text/format context) ═══
//
// Mapbox lets a label's `text-field` embed sprite images inside the glyph
// run — either the bare `["image", name]` text-field form or an `["image",
// …]` section inside `["format", …]`. X-GIS resolves a label's text-field
// to a PLAIN STRING (map/src/text/text-resolver.ts) which the shaper then
// lays out one codepoint per glyph. To carry an inline image THROUGH that
// string without inventing a parallel styled-run channel, the converter
// lowers such an image to an `image(name)` xgis builtin whose evaluator
// (evaluator-helpers.ts `case 'image'`) returns the sprite name wrapped in
// these two Private-Use-Area sentinels. The runtime shaper
// (map text-stage-helpers `parseInlineImages`) then splits the resolved
// string on the sentinels: text between them shapes as glyphs, the wrapped
// name reserves the sprite's CSS-width advance and renders an image quad.
//
// PUA U+E000 / U+E001 are chosen because real sprite names + real label
// text never contain them, so the split is unambiguous and needs no
// escaping. This is the SINGLE AUTHORITY for the marker format — both the
// compiler (builder) and @xgis/map (parser) import these constants.

/** Opening sentinel — precedes the sprite name. */
export const INLINE_IMAGE_START = '\uE000'
/** Closing sentinel — follows the sprite name. */
export const INLINE_IMAGE_END = '\uE001'

/** Wrap a resolved sprite name in the inline-image sentinels. Returned by
 *  the `image(name)` evaluator builtin; consumed by the runtime shaper. */
export function inlineImageMarker(name: string): string {
  return INLINE_IMAGE_START + name + INLINE_IMAGE_END
}
