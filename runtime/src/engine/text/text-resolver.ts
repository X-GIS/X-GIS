// ═══════════════════════════════════════════════════════════════════
// Text Resolver (Batch 1c-8a)
// ═══════════════════════════════════════════════════════════════════
//
// Closes the loop between IR and the rendered string. Given a
// `TextValue` from a layer's `LabelDef.text` and a feature's
// property bag, returns the display string the GlyphAtlasHost
// rasterises.
//
// Two branches mirror the IR:
//   - `kind: 'expr'`     → evaluate(ast, props) → String(value)
//   - `kind: 'template'` → fold each part:
//        literal → its text
//        interp  → evaluate(ast, props) → formatValue(value, spec)
//      then concat
//
// Falls back gracefully on missing fields / evaluation errors so
// a single bad feature doesn't crash an entire frame's labels.

import { evaluate, formatValue, makeEvalProps, type TextValue } from '@xgis/compiler'

export type FeatureProps = Record<string, unknown>

/** Resolve a TextValue against a feature's property bag.
 *  Returns the empty string when the value is null/undefined to
 *  match Mapbox's `text-field: null` skip semantics — caller
 *  treats the empty string as "don't render".
 *
 *  `cameraZoom` is the OPTIONAL current camera zoom. Mapbox text-field
 *  expressions that depend on zoom (e.g. demotiles
 *  `text-field: {stops:[[2,"{ABBREV}"],[4,"{NAME}"]]}` — converted to
 *  `step(zoom, .ABBREV, 4, .NAME)`) need it in the evaluator's props
 *  bag under the CAMERA_ZOOM_KEY sigil. Without this injection
 *  `zoom` evaluated to `undefined` → toNumber → NaN → `step()`
 *  returned its default arm forever and country labels never
 *  switched from "S. Kor" to "S. Korea" at z>=4.
 *
 *  `feature` (optional) wires `["id"]` / `["geometry-type"]` accessors
 *  through the matching reserved keys so a text-field expression like
 *  `["case", ["==", ["geometry-type"], "Point"], "•", .name]` (mixed-
 *  shape POI labels) resolves correctly. Mirror of the reserved-key
 *  contract the filter / width / colour / height eval paths already
 *  use (c1080d0 / 6018086 / 6633ca4 / 73f3880 / d4ffa24). */
export function resolveText(
  value: TextValue,
  props: FeatureProps,
  cameraZoom?: number,
  feature?: { id?: string | number; geometry?: { type?: string } },
): string {
  const enrichedProps = (cameraZoom !== undefined || feature !== undefined)
    ? makeEvalProps({
        props,
        cameraZoom,
        geometryType: feature?.geometry?.type,
        featureId: feature?.id,
      })
    : props
  if (value.kind === 'expr') {
    const v = safeEval(value.expr.ast, enrichedProps)
    if (v === null || v === undefined) return ''
    return String(v)
  }
  // template
  let out = ''
  for (const part of value.parts) {
    if (part.kind === 'literal') {
      out += part.value
      continue
    }
    const v = safeEval(part.expr.ast, enrichedProps)
    out += formatValue(v, part.spec)
  }
  return out
}

/** Wrap evaluate() so an expression that throws (missing field on
 *  a typed evaluator, divide-by-zero, unknown function) doesn't
 *  blow up the whole label render pass. */
function safeEval(ast: unknown, props: FeatureProps): unknown {
  try {
    return evaluate(ast as never, props)
  } catch {
    return undefined
  }
}
