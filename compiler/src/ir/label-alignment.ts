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

/** Does map/src actually lay this label INTO the ground plane?
 *
 *  `resolvePitchAlignment` above answers what the SPEC asks for. This answers
 *  what the runtime delivers, and the two are different sets — which is the
 *  whole content of the converter's runtime-gap warning (#2166). It lives beside
 *  its sibling for the reason at the head of this file: the warning and the
 *  runtime must read ONE model, or the warning drifts into describing a runtime
 *  that no longer exists (it did, on 100 % of what it fired on).
 *
 *  The runtime has exactly two ground-aligned dispatch paths, each with its own
 *  gate, and both are reproduced here:
 *
 *  • POINT — `makeGroundBasisFor` withholds the basis unless the resolved pitch
 *    alignment is `map`, and narrows on nothing else
 *    (map/src/render/passes/dispatch-point-labels.ts).
 *  • LINE — the CURVED branch of the label pass walks a pitch-0 label plane and
 *    hands the basis to each stop, but it is reached only when the label follows
 *    the tangent, i.e. `text-rotation-alignment` is anything but `viewport`
 *    (map/src/render/passes/label-pass.ts). A converted `line` layer always
 *    carries a positive `label-spacing` — the converter's symbol-spacing arm
 *    emits the 250 px default when the style omits it — so the curved branch is
 *    the branch every `line` layer takes.
 *
 *  `line-center` has neither: it emits one label per feature through the
 *  non-curved fallback (map/src/render/passes/place-labels-along-line.ts), whose
 *  `emitLabelAlongSegment` calls `addLabel` with no basis argument at all. So it
 *  stays an upright billboard however the chain resolves — the residual this
 *  predicate exists to keep honest, together with the globe (projType 7 has no
 *  map plane to lie in and is deferred with its reason in map/src/text/
 *  ground-basis.ts), which is a per-FRAME condition no per-layer predicate can
 *  see. */
export function groundAlignsAtRuntime(
  placement: unknown,
  rotationAlignment: unknown,
  pitchAlignment: unknown,
): boolean {
  if (resolvePitchAlignment(placement, rotationAlignment, pitchAlignment) !== 'map') return false
  if (placement === 'line-center') return false
  if (placement === 'line') return rotationAlignment !== 'viewport'
  return true
}
