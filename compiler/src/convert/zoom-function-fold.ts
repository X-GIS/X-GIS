// ═══ Mapbox legacy zoom functions: detection + constant folding ═══
// The `{ "stops": [[zoom, value], …], "base"?: n }` shape (Mapbox style
// spec v0/v1) and the modern `["interpolate", …]` expression are two
// spellings of one idea. This module owns recognising them and folding
// the degenerate single-stop case; `paint-helpers.ts:interpolateZoomStops`
// owns lifting the multi-stop form into the shared InterpolateZoomShape.
//
// Deliberately dependency-free: paint-helpers imports FROM here (its
// addFillTranslate pre-gate + its stop-key unwrap), so an import back
// the other way would cycle.

/** Unwrap Mapbox v8's `["literal", value]` wrapper for any scalar /
 *  array stop value or paint scalar input. The callbacks downstream
 *  type-check against the inner concrete type (number / string / array)
 *  and reject the wrapper as "not the shape I expected"; unwrapping
 *  eagerly lets a uniform code path handle both the bare and v8-
 *  strict forms. */
export function unwrapStopLiteral(v: unknown): unknown {
  // Loop unwrap so double-wraps like `["literal", ["literal", 0.5]]`
  // (rare, but emitted by some v8 strict preprocessor chains) peel
  // down to the inner scalar/array in one pass. Mirror of the loop
  // unwrap in colorToXgis (921d5ad).
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  return v
}

/** True when `v` carries a zoom-driven interpolate that
 *  `interpolateZoomCall` can lift — the MODERN
 *  `["interpolate", curve, ["zoom"], …]` array OR the LEGACY
 *  `{ "stops": [[zoom, value], …] }` object (Mapbox style spec v0/v1,
 *  still authored by the Carto / Versatiles / MapLibre-demo basemaps).
 *
 *  Single authority for the pre-gate the array- and vec2-valued paint
 *  emitters run before calling into the lift. Three private copies of
 *  the array-only test (`Array.isArray(v) && v[0] === 'interpolate'`)
 *  used to drop every legacy form on line-dasharray / line-translate /
 *  fill-translate / fill-extrusion-translate even though
 *  interpolateZoomStops has understood the legacy shape all along
 *  (#1976). */
export function isZoomInterpCandidate(v: unknown): boolean {
  if (Array.isArray(v)) return v.length >= 4 && v[0] === 'interpolate'
  return v !== null && typeof v === 'object' && Array.isArray((v as { stops?: unknown }).stops)
}

/** Fold a legacy zoom function with EXACTLY ONE stop to the constant it
 *  denotes. Mapbox / MapLibre semantics: `{"stops": [[14, 12]]}` has a
 *  single range, so it evaluates to 12 at EVERY zoom — it IS the
 *  constant 12. `interpolateZoomStops` rightly rejects it (an
 *  interpolate needs >= 2 stops to have a slope), so before this fold
 *  every single-stop legacy function dropped to its property default.
 *
 *  Deliberately conservative: a legacy DATA-DRIVEN property function
 *  (carries a `property` key) and a non-numeric stop key are returned
 *  untouched so they still reach their existing warn-and-drop path.
 *  Every other shape is returned unchanged.
 *
 *  `type` gates the fold because only the RANGE-based function types
 *  cover the whole input domain from a single stop: `exponential` and
 *  `interval` both clamp below the first stop and above the last, and
 *  with one stop those two clamps are the same stop — so every zoom
 *  resolves to it. `categorical` is exact-key match instead: it yields
 *  the stop value ONLY at input === 14 and the property default
 *  everywhere else, so folding it to a constant would silently change
 *  what renders. Unknown / non-string types bail for the same reason —
 *  we can't claim domain coverage for semantics we don't model. */
export function foldSingleStopZoomFunction(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const fn = v as { stops?: unknown; property?: unknown; type?: unknown }
  if (!Array.isArray(fn.stops) || fn.stops.length !== 1) return v
  if (typeof fn.property === 'string') return v
  if (fn.type !== undefined && fn.type !== 'exponential' && fn.type !== 'interval') return v
  const stop: unknown = fn.stops[0]
  if (!Array.isArray(stop) || stop.length < 2) return v
  const zoom = unwrapStopLiteral(stop[0])
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return v
  return unwrapStopLiteral(stop[1])
}

/** Apply `foldSingleStopZoomFunction` across a whole `layer.paint` /
 *  `layer.layout` bag, once, at the point the bag is handed to the
 *  emitters — so every property reaches its EXISTING constant path
 *  (`label-size-12`, `stroke-3`, …) instead of each emitter re-deriving
 *  the fold. Returns the bag unchanged (same reference) when nothing
 *  folds — the overwhelmingly common case — and a shallow copy
 *  otherwise, so the caller's input style object is never mutated. */
export function foldSingleStopZoomFunctions(bag: Record<string, unknown>): Record<string, unknown> {
  let folded: Record<string, unknown> | null = null
  for (const key of Object.keys(bag)) {
    const raw = bag[key]
    const constant = foldSingleStopZoomFunction(raw)
    if (constant === raw) continue
    if (folded === null) folded = { ...bag }
    folded[key] = constant
  }
  return folded ?? bag
}
