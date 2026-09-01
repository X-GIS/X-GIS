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
 *  DOMAIN — this predicate models the TILED dispatch path, and that restriction
 *  is load-bearing rather than incidental. The label pass has FOUR dispatch
 *  arms, because the SOURCE KIND picks a path before the placement does
 *  (map/src/render/passes/label-pass.ts): a source whose features live in
 *  `rawDatasets` takes "Path 1", and a tile-backed one takes "Path 2". The
 *  ground basis reaches exactly two of the four, DIAGONALLY:
 *
 *      source kind          placement          basis?   emit site
 *      ───────────────────────────────────────────────────────────────────────
 *      raw dataset          point               YES     dispatch-point-labels.ts
 *      raw dataset          line / line-center   no     placeInlineLineLabels
 *      tiled                point                no     label-pass.ts point arms
 *      tiled                line (tangent)      YES     dispatch-curved-line-labels.ts
 *      tiled                line-center          no     emitLabelAlongSegment
 *
 *  A per-LAYER predicate cannot see which column it is in — which path a source
 *  takes is decided by the SOURCE pipeline, not by anything on the layer — so it
 *  must pick one, and TILED is the honest pick for both callers.
 *
 *  For the runtime caller the choice is free: it reads this predicate from
 *  inside Path 2 (map/src/render/passes/label-pass.ts, the vector-tile branch),
 *  so the tiled column is the only column that caller can be in.
 *
 *  For the converter it is a judgement, and this is the evidence behind it.
 *  EVERY source is tiled when it attaches — map/src/source-manager.ts writes the
 *  `_vectorTile` marker both for a tile-backed source and for a GeoJSON one it
 *  ingests through the virtual-PMTiles path — and the only thing that puts a
 *  FeatureCollection back into `rawDatasets`, which is what Path 1 tests for, is
 *  the inline-GeoJSON seeding loop in map/src/map.ts. So a `vector` source is
 *  ALWAYS on the tiled column, and that is what a converted basemap is made of.
 *  Do not read the table above as a claim about which STYLE SYNTAX lands where:
 *  that mapping lives in the source pipeline, it is not a layer property, and it
 *  is deliberately not restated here — a second copy of it would be the
 *  two-authorities trap this file exists to avoid.
 *
 *  On that column the basis is wired for ONE cell, and these are the gates:
 *
 *  • LINE — the CURVED branch walks a pitch-0 label plane and hands the basis to
 *    each stop, but it is reached only when the label follows the tangent, i.e.
 *    `text-rotation-alignment` is anything but `viewport`. A converted `line`
 *    layer always carries a positive `label-spacing` — the converter's
 *    symbol-spacing arm emits the 250 px default when the style omits it — so
 *    the curved branch is the branch every `line` layer takes.
 *  • POINT — the tiled point arms call `addLabel` with ten arguments and stop
 *    before the basis parameter, so a tile-backed point label is a billboard
 *    however the chain resolves. `makeGroundBasisFor` is wired on the RAW arm
 *    only. This is the cell the predicate used to claim (`return true`) and does
 *    not claim any more.
 *  • LINE-CENTER — emits one label per feature through the non-curved fallback,
 *    whose `emitLabelAlongSegment` calls `addLabel` with no basis argument at
 *    all.
 *
 *  Two residuals therefore sit OUTSIDE this predicate's reach by construction,
 *  and the callers' notes name them rather than pretending otherwise: the
 *  raw-dataset line cell (which billboards while this predicate says the tiled
 *  line cell does not), and the globe — projType 7 has no map plane to lie in
 *  and is deferred with its reason in map/src/text/ground-basis.ts, a per-FRAME
 *  condition no per-layer predicate can see. */
export function groundAlignsAtRuntime(
  placement: unknown,
  rotationAlignment: unknown,
  pitchAlignment: unknown,
): boolean {
  if (resolvePitchAlignment(placement, rotationAlignment, pitchAlignment) !== 'map') return false
  // The ONLY ground-aligned cell of the tiled column (see DOMAIN above): line
  // placement that reaches the tangent-rotated curved branch. Point and
  // line-center both fall through to `false`.
  if (placement === 'line') return rotationAlignment !== 'viewport'
  return false
}
