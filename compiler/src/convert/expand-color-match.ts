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
export function expandPerFeatureColorMatch(layer: MapboxLayer): MapboxLayer[] | null {
  if (layer.type !== 'fill') return null
  const paint = (layer.paint ?? {}) as Record<string, unknown>
  const fc = paint['fill-color']
  if (!Array.isArray(fc) || fc[0] !== 'match') return null

  // Mapbox match shape: ['match', input, val1, out1, val2, out2, …, default]
  // The input must be `['get', field]` — a literal expression input
  // can't be split into a value-set filter.
  const input = fc[1]
  if (!Array.isArray(input) || input[0] !== 'get' || typeof input[1] !== 'string') return null
  const field = input[1] as string

  const args = fc.slice(2)
  // Need at least one (vals, out) pair and a default — i.e. 3 args.
  if (args.length < 3 || args.length % 2 === 0) return null

  // Group values by output colour. The match can have repeated
  // colours (e.g. ['v1', 'v2'] → '#abc', 'v3' → '#abc' both
  // resolve to same colour) — coalesce them so we emit one sublayer
  // per UNIQUE colour rather than per (vals, out) tuple.
  // Default colour can also be v8-literal-wrapped — same unwrap as
  // the per-arm out below.
  let defaultOut = args[args.length - 1]
  if (Array.isArray(defaultOut) && defaultOut.length === 2 && defaultOut[0] === 'literal'
      && typeof defaultOut[1] === 'string') {
    defaultOut = defaultOut[1]
  }
  if (typeof defaultOut !== 'string') return null  // non-colour-string default

  const byColour = new Map<string, (string | number)[]>()
  const allVals: (string | number)[] = []
  for (let i = 0; i + 1 < args.length - 1; i += 2) {
    // Mapbox v8 strict tooling can wrap the keys-array form
    // (`["literal", ["v1", "v2"]]`) — same case the main match handler
    // handles. Without unwrap the outer Array.isArray passed and the
    // inner iteration treated "literal" + the inner array as keys,
    // bailing the whole expand at the typeof check and falling back
    // to lower.ts's pick-first-stop fallback — the layer rendered
    // ONE colour instead of per-feature palette.
    let vals = args[i]
    if (Array.isArray(vals) && vals.length === 2 && vals[0] === 'literal') {
      vals = vals[1]
    }
    // Same v8 literal-wrap unwrap on the value (colour string) side.
    // Strict tooling can emit `["literal", "#abc"]` for the colour
    // arm; pre-fix the typeof string check failed on the wrap and
    // the whole expand bailed → layer fell to lower.ts's pick-first-
    // stop fallback (one colour for every feature).
    let out = args[i + 1]
    if (Array.isArray(out) && out.length === 2 && out[0] === 'literal'
        && typeof out[1] === 'string') {
      out = out[1]
    }
    if (typeof out !== 'string') return null  // every arm must be a colour string
    const valList = Array.isArray(vals) ? vals : [vals]
    for (let v of valList) {
      // Inner per-element literal-wrap, mirror of the match-handler
      // double-wrap fix (47d1d81). The outer unwrap above only peels
      // the array wrapper; each element may still be `["literal", x]`.
      if (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
      if (typeof v !== 'string' && typeof v !== 'number') return null
      allVals.push(v)
      const bucket = byColour.get(out) ?? []
      bucket.push(v)
      byColour.set(out, bucket)
    }
  }
  // Must have ≥ 2 distinct colours; a 1-colour match is effectively
  // a constant and lower.ts handles it fine.
  if (byColour.size < 2) return null

  const baseFilter = layer.filter
  const out: MapboxLayer[] = []
  let suffix = 0
  for (const [colour, vals] of byColour) {
    const inFilter: InFilter = ['in', ['get', field], ['literal', vals]]
    const filter = combineFilter(baseFilter, inFilter)
    const sub = cloneLayerWithOverrides(layer, {
      id: `${layer.id}__c${suffix++}`,
      filter,
      paint: { ...paint, 'fill-color': colour },
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
    paint: { ...paint, 'fill-color': defaultOut },
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
  // Cast through unknown — the override paint preserves all original
  // fields and only swaps the `fill-color` constant. Type system
  // doesn't lose anything the original layer didn't already permit.
  return {
    ...(base as unknown as Record<string, unknown>),
    id: overrides.id,
    filter: overrides.filter,
    paint: overrides.paint,
  } as unknown as MapboxLayer
}
