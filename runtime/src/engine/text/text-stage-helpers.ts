// Pure (WebGPU-free) text-stage helpers. text-stage.ts imports from
// here for production use; tests can import without pulling in
// TextRenderer's WGSL pipeline + GPU types.

/** Mapbox `text-transform` — uppercase / lowercase / none.
 *  Note for CJK: case mapping is undefined for ideographs and
 *  hangul — Unicode default-cased mappings pass them through. */
export function applyTextTransform(
  s: string,
  t?: 'none' | 'uppercase' | 'lowercase',
): string {
  if (t === 'uppercase') return s.toUpperCase()
  if (t === 'lowercase') return s.toLowerCase()
  return s
}

/** Mapbox bilingual `text-field: concat(name:latin, "\n",
 *  name:nonlatin)` stacks two scripts on point labels as two lines.
 *  Along a CURVED road, however, Mapbox's reference rendering shows
 *  only the primary (Latin) script — laying both head-to-tail along
 *  the path is the visible artefact. Strip everything from the first
 *  LF onwards before the curve sampler walks the glyph sequence. */
export function stripCurveLineExtraScripts(text: string): string {
  const lf = text.indexOf('\n')
  return lf >= 0 ? text.slice(0, lf) : text
}
