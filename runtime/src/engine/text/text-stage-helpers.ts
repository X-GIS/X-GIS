// Re-exports the bits of text-stage that are testable without
// WebGPU. Keeps the test file from importing text-stage directly
// (which would pull in TextRenderer's WGSL pipeline + GPU types).

export function applyTextTransformForTesting(
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
