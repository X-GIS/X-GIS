// ═══ #1496 — seam-needle discard for flat non-Mercator fills ═══
//
// A rotated projection's branch cut (oblique: the rotated antimeridian) tracks
// the camera and crosses tile interiors, so a fill triangle can straddle it: one
// vertex projects to x ≈ +πR, the others to x ≈ −πR, and the triangle rasterises
// as a 1–2 px needle across the whole frame. The line VS degenerates such
// segments because it holds both endpoints (line.ts finalize, #1496); a fill
// vertex sees only itself, and a fragment cannot tell a needle from a legitimate
// triangle by any interpolated quantity alone — the needle is a correct
// rasterisation of the wrong topology. So the vertex carries its projected x
// TWICE: interpolated and `flat` (the provoking vertex's). On a legitimate
// triangle they differ by at most the triangle's own width; mid-needle by up to
// 2πR. Discard beyond πR/8 (≈ 2 500 km, 22.5° of rotated longitude): 2.5× the
// widest edge the tiler emits at z0 (#2435, 9°). What survives is a stub of at
// most πR/8 from the provoking vertex, at the cut — off-screen wherever the frame
// is narrower than a world, and under the neighbouring world copy's fill elsewhere.
// Gated like the line guard (proj_params.x > 0.5): Mercator's cut is tile-aligned.
// A per-tile unwrap instead is the #802 trap (adjacent tiles tear at the cut).

import { If, Discard, abs, type ReadonlyNode } from '@xgis/shader-dsl'
import { PI, EARTH_R } from './consts'

/** Emit the needle discard into a polygon fragment entry. `seamX` / `seamXFlat`
 *  are the VertexOutput's `seam_x` / `seam_x_flat` (0 / 0 off the flat arm). */
export function emitSeamNeedleDiscard(
  projType: ReadonlyNode<'f32'>,
  seamX: ReadonlyNode<'f32'>,
  seamXFlat: ReadonlyNode<'f32'>,
): void {
  If(projType.gt(0.5), () => {
    If(abs(seamX.sub(seamXFlat)).gt(PI.mul(EARTH_R).div(8)), () => {
      Discard()
    })
  })
}
