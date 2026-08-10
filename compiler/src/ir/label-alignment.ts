// ═══ #777 IV3 — text-pitch-alignment, resolved ═══
//
// The Mapbox spec resolves `text-pitch-alignment` through a chain, and the chain
// is the whole story: BOTH knobs default to `auto`, and the defaults route a
// style into `map` without it authoring anything.
//
//   text-rotation-alignment: auto  →  map      for `line` / `line-center` placement
//                                     viewport for point placement
//   text-pitch-alignment:    auto  →  whatever text-rotation-alignment resolved to
//
// So every road name, waterway name and along-line shield is pitch-aligned `map`
// by default. Measured on `playground/e2e/__convert-fixtures/bright.json`: 25
// symbol layers, ZERO of which author `text-pitch-alignment`, and 10 of them
// line-placed. Reading the property as "opt-in" — which its `[partial/low]` row
// in the coverage table implied — under-counts the affected set by all of it.
//
// This lives in `ir/` rather than in the converter because it now has TWO
// callers that must not drift: the converter's runtime-gap warning (#1432), and
// the runtime that actually builds the ground basis. A second copy of this chain
// would be the two-authorities trap CLAUDE.md §12 keeps paying for — and the
// failure would be silent in the worst way, with the converter reporting a gap
// the runtime does not fill or vice versa.

/** The resolved value of an alignment knob. `auto` never survives resolution. */
export type ResolvedAlignment = 'map' | 'viewport'

/** True for the placements whose `auto` rotation-alignment is `map`. */
export function isLinePlacement(placement: unknown): boolean {
  return placement === 'line' || placement === 'line-center'
}

/** `text-rotation-alignment`, resolved. An explicit enum wins; `auto` (and any
 *  absent / malformed value, which the converter reports separately) falls to
 *  the placement default. */
export function resolveRotationAlignment(
  placement: unknown,
  rotationAlignment: unknown,
): ResolvedAlignment {
  if (rotationAlignment === 'map' || rotationAlignment === 'viewport') return rotationAlignment
  return isLinePlacement(placement) ? 'map' : 'viewport'
}

/** `text-pitch-alignment`, resolved through the full spec chain.
 *
 *  `map` means the label lies IN the ground plane — it foreshortens and tilts
 *  with the camera instead of standing up as a billboard. That is the value the
 *  runtime must build a ground basis for; `viewport` is the billboard it has
 *  always drawn. */
export function resolvePitchAlignment(
  placement: unknown,
  rotationAlignment: unknown,
  pitchAlignment: unknown,
): ResolvedAlignment {
  if (pitchAlignment === 'map' || pitchAlignment === 'viewport') return pitchAlignment
  return resolveRotationAlignment(placement, rotationAlignment)
}
