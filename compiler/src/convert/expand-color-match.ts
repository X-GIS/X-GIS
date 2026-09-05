// Preprocessor: split a `fill-color: ["match", ["get", field], …,
// default]` Mapbox layer into one sublayer per unique constant
// colour. Each sublayer takes a value-set filter that picks just the
// features mapped to its colour; the default arm becomes a "fallback"
// sublayer with a NOT-IN filter over the union of explicit values.
//
// **Why this exists** — runtime fills bake one colour per draw call
// (uniform `u.fill_color` in the polygon shader). Per-feature distinct
// colours would need a parallel vertex attribute buffer plus a new
// fill pipeline that reads it; until that lands, the IR's
// `data-driven` fill collapses to a single constant at lower.ts
// (extractMatchDefaultColor — the default arm wins, every feature
// renders the same colour). For typical OFM Bright the match is
// 1-3 colours and the collapse looks fine; for MapLibre demotiles
// `countries-fill` with 8 distinct country-palette colours the
// collapse destroys the entire visual — every country renders in
// the default sand colour `#EAB38F`.
//
// The split keeps draw-call count bounded — one extra draw per
// unique colour. demotiles needs 9 colours = 9 layer blocks instead
// of 1, which lower.ts + the runtime handle exactly the same as any
// other multi-layer style.
//
// Limited to `fill`-type layers in v1. `line` (`line-color` match)
// and `fill-extrusion` (`fill-extrusion-color` match) can adopt the
// same split with no further machinery.
//
// #2380 — that "no further machinery" is now cashed in for the PATTERN
// properties rather than the colour ones. A `match()` over SPRITE NAMES is
// structurally the same object as a match over colours: a finite map from a
// feature field to a constant string. The runtime bakes one pattern per draw
// (`show.fillPattern` is a single string, resolved to one UV bbox at
// render-loop.ts:881), which is the same one-constant-per-draw limit that made
// this splitter exist for colour. So the split applies verbatim, and each
// sublayer carries a CONSTANT sprite name — the form already supported
// end-to-end on both backends.
//
// This is deliberately NOT the per-feature-variant design: composing the bbox
// into the fill variant would also need a per-feature REPEAT (sprite pixel
// sizes differ, and repeat is recomputed per frame from camera zoom), and any
// atlas-of-bboxes shape would hit `rhiVariantFillSupported`'s r32float fence
// and fail to LINK on WebGL2. The split needs no shader, no variant, no new
// binding, and no backend asymmetry. Its cost is the same bounded draw-call
// fanout already accepted here for colour: one draw per unique sprite.

import type { MapboxLayer } from './types'

/** Mapbox `["in", ["get", field], ["literal", [v1, v2, …]]]`
 *  expression-form filter. `expand-color-match` emits the expression
 *  form (vs the legacy `["in", "field", v1, v2, …]`) because the
 *  expression form is what `filterToXgis` actually handles at
 *  `expressions.ts:332-345`. */
type InFilter = [string, [string, string], [string, (string | number)[]]]

/** Return `null` when the layer doesn't qualify for splitting (most
 *  layers). Otherwise an array of synthesised sublayers — one per
 *  unique colour — that together cover the original layer's
 *  features. Caller emits each sublayer through `convertLayer` as
 *  usual; the result is a slightly inflated layer count for a layer
 *  that needs per-feature colour. */
/** What distinguishes one split from another. The BODY is already generic over
 *  these — every arm below reads a constant string out of a `match` and groups
 *  values by it — so the colour and pattern splits differ only here. */
interface SplitSpec {
  /** Mapbox layer `type` this split applies to. */
  layerType: string
  /** The paint property carrying the `match`. */
  property: string
  /** What the arm outputs are, for the bail warnings ("colour" / "sprite name"). */
  outputNoun: string
  /** Smallest distinct-output count worth splitting.
   *
   *  2 for colour: a 1-colour match is effectively a constant and lower.ts
   *  handles it. 1 for pattern: with one explicit arm plus a DIFFERENT default
   *  arm the layer still draws two different sprites, and bailing would send it
   *  to the converter's non-constant decline instead — a visible loss, where
   *  colour merely falls back to an equivalent constant. */
  minDistinct: number
}

const COLOR_SPLIT: SplitSpec = {
  layerType: 'fill',
  property: 'fill-color',
  outputNoun: 'colour',
  minDistinct: 2,
}

/** #2380 — the three pattern properties, each on its own layer type. */
const PATTERN_SPLITS: readonly SplitSpec[] = [
  { layerType: 'fill', property: 'fill-pattern', outputNoun: 'sprite name', minDistinct: 1 },
  { layerType: 'line', property: 'line-pattern', outputNoun: 'sprite name', minDistinct: 1 },
  {
    layerType: 'fill-extrusion',
    property: 'fill-extrusion-pattern',
    outputNoun: 'sprite name',
    minDistinct: 1,
  },
]

export function expandPerFeatureColorMatch(
  layer: MapboxLayer,
  warnings?: string[],
): MapboxLayer[] | null {
  return expandPerFeatureMatch(layer, COLOR_SPLIT, warnings)
}

/** #2380 — split a `match()` over sprite names into one sublayer per unique
 *  sprite, each with the CONSTANT form the runtime already supports. Returns
 *  null when the layer carries no splittable pattern match, so the caller falls
 *  through to its existing handling (including the non-constant decline). */
export function expandPerFeaturePatternMatch(
  layer: MapboxLayer,
  warnings?: string[],
): MapboxLayer[] | null {
  for (const spec of PATTERN_SPLITS) {
    const split = expandPerFeatureMatch(layer, spec, warnings)
    if (split) return split
  }
  return null
}

function expandPerFeatureMatch(
  layer: MapboxLayer,
  spec: SplitSpec,
  warnings?: string[],
): MapboxLayer[] | null {
  if (layer.type !== spec.layerType) return null
  // Defensive: layer.paint should be an object per spec. A non-object
  // form (string, array, etc. from malformed JSON) would otherwise let
  // `paint['fill-color']` index a char or undefined.
  const rawPaint = layer.paint
  if (
    rawPaint !== null &&
    rawPaint !== undefined &&
    (typeof rawPaint !== 'object' || Array.isArray(rawPaint))
  ) {
    return null
  }
  const paint = (rawPaint ?? {}) as Record<string, unknown>
  const fc = paint[spec.property]
  if (!Array.isArray(fc) || fc[0] !== 'match') return null

  // Mapbox match shape: ['match', input, val1, out1, val2, out2, …, default]
  // The input must be `['get', field]` — a literal expression input
  // can't be split into a value-set filter.
  const input = fc[1]
  if (!Array.isArray(input) || input[0] !== 'get') return null
  // Peel wrapped field name on the get accessor — mirror of the legacy
  // comparison fix (8013bc3). Pre-fix `['get', ['literal', 'kind']]`
  // failed the typeof gate and the whole expand bailed → layer fell
  // back to the pick-first-stop fallback (single colour for every
  // feature on a per-country palette match).
  let getField: unknown = input[1]
  while (Array.isArray(getField) && getField.length === 2 && getField[0] === 'literal') {
    getField = getField[1]
  }
  if (typeof getField !== 'string') return null
  const field = getField

  const args = fc.slice(2)
  // Need at least one (vals, out) pair and a default — i.e. 3 args.
  if (args.length < 3 || args.length % 2 === 0) {
    warnings?.push(
      `Layer "${layer.id}" — ${spec.property} match has ${args.length} args; expected odd count ≥ 3 (val1, out1, …, default). Per-feature ${spec.outputNoun} expand bailed; the layer will render with a single fallback ${spec.outputNoun}.`,
    )
    return null
  }

  // Group values by output colour. The match can have repeated
  // colours (e.g. ['v1', 'v2'] → '#abc', 'v3' → '#abc' both
  // resolve to same colour) — coalesce them so we emit one sublayer
  // per UNIQUE colour rather than per (vals, out) tuple.
  // Default colour can also be v8-literal-wrapped — same unwrap as
  // the per-arm out below.
  let defaultOut = args[args.length - 1]
  // Loop peel for multi-level wraps. Drop the inner === 'string' gate
  // so doubly-wrapped colours peel through. Mirror of colorToXgis (921d5ad).
  while (Array.isArray(defaultOut) && defaultOut.length === 2 && defaultOut[0] === 'literal') {
    defaultOut = defaultOut[1]
  }
  if (typeof defaultOut !== 'string') {
    // The match LOOKS like a per-feature colour palette (fill-type +
    // match + get-field input) but the default arm isn't a constant
    // colour. The split bails; lower.ts's pick-first-stop fallback
    // takes over and the layer renders ONE colour for every feature.
    // Surface so the author sees why an 8-country palette collapsed
    // to one colour.
    warnings?.push(
      `Layer "${layer.id}" — ${spec.property} match default arm is not a constant ${spec.outputNoun} string; per-feature ${spec.outputNoun} expand bailed and the layer will render with a single fallback ${spec.outputNoun}.`,
    )
    return null
  }

  const byColour = new Map<string, (string | number)[]>()
  const allVals: (string | number)[] = []
  // Track values already assigned to an earlier colour arm so that a
  // duplicate key (which violates the Mapbox spec but must be handled
  // gracefully) only ever appears under the FIRST arm that claims it,
  // preserving match's first-arm-wins ordering. Also prevents the same
  // value from appearing twice in allVals (the default NOT-IN filter).
  const seen = new Set<string | number>()
  for (let i = 0; i + 1 < args.length - 1; i += 2) {
    // Mapbox v8 strict tooling can wrap the keys-array form
    // (`["literal", ["v1", "v2"]]`) — same case the main match handler
    // handles. Without unwrap the outer Array.isArray passed and the
    // inner iteration treated "literal" + the inner array as keys,
    // bailing the whole expand at the typeof check and falling back
    // to lower.ts's pick-first-stop fallback — the layer rendered
    // ONE colour instead of per-feature palette.
    let vals = args[i]
    while (Array.isArray(vals) && vals.length === 2 && vals[0] === 'literal') {
      vals = vals[1]
    }
    // Same v8 literal-wrap unwrap on the value (colour string) side.
    // Strict tooling can emit `["literal", "#abc"]` for the colour
    // arm; pre-fix the typeof string check failed on the wrap and
    // the whole expand bailed → layer fell to lower.ts's pick-first-
    // stop fallback (one colour for every feature).
    let out = args[i + 1]
    while (Array.isArray(out) && out.length === 2 && out[0] === 'literal') {
      out = out[1]
    }
    if (typeof out !== 'string') {
      warnings?.push(
        `Layer "${layer.id}" — ${spec.property} match arm output is not a constant ${spec.outputNoun} string (got ${typeof out}); per-feature ${spec.outputNoun} expand bailed and the layer will render with a single fallback ${spec.outputNoun}.`,
      )
      return null
    }
    const valList = Array.isArray(vals) ? vals : [vals]
    for (let v of valList) {
      // Inner per-element literal-wrap, mirror of the match-handler
      // double-wrap fix (47d1d81). The outer unwrap above only peels
      // the array wrapper; each element may still be `["literal", x]`.
      while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
      if (typeof v !== 'string' && typeof v !== 'number') {
        // A key in the match's value-list is neither a scalar string
        // nor number (e.g. an expression or object); the value-set
        // filter can't represent it. Surface so author sees why the
        // palette expand bailed.
        warnings?.push(
          `Layer "${layer.id}" — ${spec.property} match contains a non-scalar key value (${typeof v}); per-feature ${spec.outputNoun} expand bailed and the layer will render with a single fallback ${spec.outputNoun}.`,
        )
        return null
      }
      // Skip values already claimed by an earlier arm — first-arm-wins.
      if (seen.has(v)) continue
      seen.add(v)
      allVals.push(v)
      const bucket = byColour.get(out) ?? []
      bucket.push(v)
      byColour.set(out, bucket)
    }
  }
  // See SplitSpec.minDistinct for why this is 2 for colour and 1 for pattern.
  if (byColour.size < spec.minDistinct) return null

  const baseFilter = layer.filter
  const out: MapboxLayer[] = []
  let suffix = 0
  for (const [colour, vals] of byColour) {
    const inFilter: InFilter = ['in', ['get', field], ['literal', vals]]
    const filter = combineFilter(baseFilter, inFilter)
    const sub = cloneLayerWithOverrides(layer, {
      id: `${layer.id}__c${suffix++}`,
      filter,
      paint: { ...paint, [spec.property]: colour },
    })
    out.push(sub)
  }
  // Default arm — features whose field value is NOT in any explicit
  // arm. Negate the expression-form `in` via `!`.
  const notInFilter = ['!', ['in', ['get', field], ['literal', allVals]]]
  const defaultFilter = combineFilter(baseFilter, notInFilter)
  const defaultSub = cloneLayerWithOverrides(layer, {
    id: `${layer.id}__cd`,
    filter: defaultFilter,
    paint: { ...paint, [spec.property]: defaultOut },
  })
  out.push(defaultSub)

  return out
}

/** AND-combine the layer's existing filter with the split's value-set
 *  filter. Both are Mapbox legacy/expression filters; we wrap with
 *  `["all", …]` if there's an existing one, else just return the new
 *  filter. */
function combineFilter(existing: unknown, added: unknown): unknown {
  if (existing === undefined || existing === null) return added
  // `["all"]` (empty all) is Mapbox's "no filter" idiom — drop it.
  if (Array.isArray(existing) && existing[0] === 'all' && existing.length === 1) {
    return added
  }
  return ['all', existing, added]
}

function cloneLayerWithOverrides(
  base: MapboxLayer,
  overrides: { id: string; filter: unknown; paint: Record<string, unknown> },
): MapboxLayer {
  // The override preserves every original field and only swaps id /
  // filter / paint — all three already `string` / `unknown` /
  // `Record<string, unknown>` on MapboxLayer, so the spread stays a
  // structurally valid MapboxLayer with no forced cast.
  return {
    ...base,
    id: overrides.id,
    filter: overrides.filter,
    paint: overrides.paint,
  }
}
