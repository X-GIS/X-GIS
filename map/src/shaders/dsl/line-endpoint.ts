// ═══ Line endpoint math — extracted from line.ts (#2042 INC-6) ═══
//
// `line_endpoint`, verbatim from line.ts but with the TILE camera lanes passed as
// PARAMETERS — the same split line-corner.ts already established for finalize_corner
// (#1003): the uniform struct is line.ts module state, so taking the lanes as args keeps
// this module cycle-free and the function pure. line.ts wraps it in a one-line adapter
// that feeds its own TILE fields, so every call site reads as before.
//
// The extraction is not a LOC dodge. INC-6 has to parameterise exactly this function
// anyway: its cam_h/cam_l read is one of the three sites the Mercator recombination
// replaces, and the pair it needs is a flag-selected expression rather than a raw lane.
// Doing it as a parameter split means the recombination is chosen ONCE by the caller
// instead of being re-derived inside a helper that cannot see the flag.
//
// Stage note, because it changed under this file's feet: after #2089 moved the globe line
// VS onto CPU-exact ECEF endpoint lanes, `line_endpoint` is called ONLY from the fragment
// helpers (`compute_line_color`, `line_rim_alpha`). It is no longer a vertex-stage
// consumer, so a caller-scope `Let` in `vs_line` could not have reached it.

import { fn, select, vec2fT, vec4fT, type Node, type ReadonlyNode } from '@xgis/shader-dsl'

/** Camera-relative endpoint, single-exit. Mercator (proj < 0.5) subtracts the camera;
 *  every other projection uses hi+lo directly. `select` is branchless — both arms are
 *  pure reads, so computing the unused one is free of side effects. */
export const lineEndpointWith = fn(
  'line_endpoint',
  { p_h: vec2fT, p_l: vec2fT, cam_h: vec2fT, cam_l: vec2fT, proj_params: vec4fT },
  (p) => {
    const mercRel = p.p_h.sub(p.cam_h).add(p.p_l.sub(p.cam_l))
    return select(p.proj_params.x.lt(0.5), mercRel, p.p_h.add(p.p_l))
  },
)

/** The shape line.ts's one-line adapter satisfies, mirroring FinalizeCornerAdapter. */
export type LineEndpointAdapter = (a: {
  p_h: ReadonlyNode<'vec2<f32>'>
  p_l: ReadonlyNode<'vec2<f32>'>
}) => Node<'vec2<f32>'>
