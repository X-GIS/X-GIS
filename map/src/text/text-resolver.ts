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
// ─── Per-frame resolution cache (perf: high-pitch pan-drag) ──────────
//
// resolveText() runs for EVERY label EVERY frame (text-stage.addLabel /
// addCurvedLineLabel + the label-pass dedupe keys). Each call did a
// full `{ ...safeProps }` spread (makeEvalProps) + an evaluate() AST
// walk. During a pan/drag the inputs that the resolved string depends
// on — the feature `props`, the TextValue AST, the camera zoom, and the
// feature id / geometry-type — are unchanged frame-to-frame, so ~100 %
// of that work was redundant. Mirror of the applyFeatureExprs WeakMap in
// label-pass.ts (iter-259).
//
// KEY (everything the resolved string can depend on):
//   - props object reference   → WeakMap outer key. PMTiles/MVT return
//     the SAME props ref per feature across frames, so the entry is
//     stable across a pan; GeoJSON with `properties: null` allocates a
//     fresh `{}` per call (no hit, no staleness — correctly skipped).
//   - value (TextValue) reference → different shows pass different
//     text-field ASTs for the same props; must invalidate.
//   - cameraZoom — text-field `step(zoom,…)` / `interpolate(zoom,…)`
//     switch the resolved string with zoom. Stored EXACT (not bucketed):
//     a coarse bucket could freeze the "S. Kor"→"S. Korea" switch within
//     a bucket. During a pan zoom is constant ⇒ hits; a zoom changes the
//     value ⇒ miss ⇒ re-resolve. Exact-equal ⇒ output is bit-identical.
//   - featureId / geometryType — `["id"]` / `["geometry-type"]`
//     accessors read these; included in the key.
//
// Only the RESOLVED STRING is cached (the expensive output). On a hit we
// return it directly, skipping both the spread and the AST walk. Output
// is never changed for any (value, props, zoom, id, geomType) tuple.
interface ResolveCacheEntry {
  value: TextValue
  cameraZoom: number | undefined
  featureId: string | number | undefined
  geometryType: string | undefined
  text: string
}
const resolveCache = new WeakMap<object, ResolveCacheEntry>()

export function resolveText(
  value: TextValue,
  props: FeatureProps,
  cameraZoom?: number,
  feature?: { id?: string | number; geometry?: { type?: string } },
): string {
  const featureId = feature?.id
  const geometryType = feature?.geometry?.type
  // props is typed as a plain record; guard the WeakMap against a
  // non-object boundary value (string/array cast) so we never throw and
  // fall through to the uncached path for those degenerate inputs.
  const keyable = props !== null && typeof props === 'object'
  if (keyable) {
    const hit = resolveCache.get(props)
    if (hit !== undefined
        && hit.value === value
        && hit.cameraZoom === cameraZoom
        && hit.featureId === featureId
        && hit.geometryType === geometryType) {
      return hit.text
    }
  }
  const text = resolveTextUncached(value, props, cameraZoom, featureId, geometryType)
  if (keyable) {
    resolveCache.set(props, { value, cameraZoom, featureId, geometryType, text })
  }
  return text
}

function resolveTextUncached(
  value: TextValue,
  props: FeatureProps,
  cameraZoom: number | undefined,
  featureId: string | number | undefined,
  geometryType: string | undefined,
): string {
  const enrichedProps = (cameraZoom !== undefined || featureId !== undefined || geometryType !== undefined)
    ? makeEvalProps({ props, cameraZoom, geometryType, featureId })
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
