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

export type LabelAnchor =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

// MapLibre's `baselineOffset`: the radial offset is to the EDGE of the
// text box, but vertically glyphs "start" at the baseline, not the box
// top. MapLibre assumes ONE_EM - 17 = 7 layout-px (ONE_EM = 24); in
// X-GIS we keep offsets in em (multiplied by sizePx at draw time), so
// 7 layout-px = 7/24 em. Replicated verbatim so variable-anchor labels
// land where MapLibre puts them (user opted for MapLibre-latest parity).
const ONE_EM = 24
const BASELINE_OFFSET_EM = 7 / ONE_EM

/** Port of MapLibre `evaluateVariableOffset` (variable_text_anchor.ts)
 *  in em units. For variable-placement labels (`text-variable-anchor`)
 *  MapLibre nudges the text away from the anchor point per candidate:
 *  a radial push (`text-radial-offset`) or an absolute `text-offset`,
 *  both routed through anchor-specific sign/axis rules plus the
 *  baseline correction. `isRadial` selects `fromRadialOffset` (offset =
 *  [radius, _]) vs `fromTextOffset` (offset = [dx, dy]). Returns the
 *  em-space [dx, dy] to ADD on top of X-GIS's box-anchor alignment. */
export function evaluateVariableOffsetEm(
  anchor: LabelAnchor,
  offset: [number, number],
  isRadial: boolean,
): [number, number] {
  let x = 0, y = 0
  if (isRadial) {
    let r = offset[0]
    if (r < 0) r = 0 // Mapbox ignores a negative radial offset.
    const hyp = r / Math.SQRT2 // solve r^2 + r^2 = radialOffset^2
    switch (anchor) {
      case 'top-right':
      case 'top-left': y = hyp - BASELINE_OFFSET_EM; break
      case 'bottom-right':
      case 'bottom-left': y = -hyp + BASELINE_OFFSET_EM; break
      case 'bottom': y = -r + BASELINE_OFFSET_EM; break
      case 'top': y = r - BASELINE_OFFSET_EM; break
    }
    switch (anchor) {
      case 'top-right':
      case 'bottom-right': x = -hyp; break
      case 'top-left':
      case 'bottom-left': x = hyp; break
      case 'left': x = r; break
      case 'right': x = -r; break
    }
    return [x, y]
  }
  // fromTextOffset — absolute values, anchor picks the sign/axis.
  const ox = Math.abs(offset[0])
  const oy = Math.abs(offset[1])
  switch (anchor) {
    case 'top-right':
    case 'top-left':
    case 'top': y = oy - BASELINE_OFFSET_EM; break
    case 'bottom-right':
    case 'bottom-left':
    case 'bottom': y = -oy + BASELINE_OFFSET_EM; break
  }
  switch (anchor) {
    case 'top-right':
    case 'bottom-right':
    case 'right': x = -ox; break
    case 'top-left':
    case 'bottom-left':
    case 'left': x = ox; break
  }
  return [x, y]
}

/** Port of MapLibre's `text-variable-anchor-offset` branch: the raw
 *  per-anchor em offset is used as-authored (NOT run through the
 *  sign/axis rules) but still gets the top/bottom baseline shift. */
export function variableAnchorOffsetEm(
  anchor: LabelAnchor,
  offset: [number, number],
): [number, number] {
  let y = offset[1]
  if (anchor.startsWith('top')) y -= BASELINE_OFFSET_EM
  else if (anchor.startsWith('bottom')) y += BASELINE_OFFSET_EM
  return [offset[0], y]
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
