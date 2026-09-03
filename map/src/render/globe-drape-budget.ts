// ═══ #2094 — WHEN the globe's fills take the bake→drape path, priced in pixels ═══
//
// `bakesVectorDrape` (geo/src/projections-table.ts) says WHICH SURFACE can drape.
// This says WHEN it is still worth it, and it replaced a LOD ceiling
// (`GLOBE_DIRECT_MIN_SELECTION_Z`, retired) because a level cannot express the
// question the two paths actually differ on.
//
// THE TWO ERRORS. The bake's cost is a RESAMPLE: the tile rasterises to a texture
// and the sphere grid samples it, ~1 device px of filter on every edge, at every
// zoom, and no bake density removes it (#2346 measured it as road casings 1 px
// wider than the Mercator control even at Δz 0.5). The direct arm's cost is a
// CHORD: a straight screen-space segment standing in for the great-circle arc
// between two projected vertices, which is
//
//     err_px = R_px · (1 − cos(θ/2)),   R_px = TILE_PX·2^Z / 2π
//
// with θ the finest edge the TILER left on that tile (`tileSegmentAngleRad` — the
// subdivision authority owns that number, this module must not re-derive it).
// θ is fixed per tile level; R_px doubles per level of camera zoom. So the direct
// error is a pure function of (drawn level, camera zoom) and grows only when the
// camera runs PAST what the source can supply — which is exactly when the #2024
// windowed sub-tiles, each a full-resolution 512px window of a resident ancestor,
// are the only tool that can add detail the cached mesh does not have.
//
// WHY NOT A LEVEL, AND WHY NOT A Δz. A level ceiling made every low zoom on a deep
// source drape (the z0–z5 blur the owner reported, still visible on WebGPU while
// WebGL2 — which never bakes — looked right). A Δz threshold cannot work either:
// θ stops shrinking once a tile edge falls under the tiler's absolute 2° gate, so
// the Δz that reaches a fixed pixel budget swings from 0.35 to 6.3 across source
// depths — demotiles at Δz 3.6 carries MORE error (4.8 px) than Positron at Δz 7.1
// (3.3 px). Only the pixel form orders those two correctly.
//
// THE BUDGET, and what fixes it. Measured on OFM Positron / dpr 2 / SwiftShader,
// drape vs direct vs a Mercator control:
//
//   z18.0  Δz 4.0  direct err 0.39 px   D1 41.68 % < D0 44.28 %   direct wins
//   z21.1  Δz 7.1  direct err 3.35 px   scalars tie at ~9 %, and the FRAMES break
//                                       the tie: the drape draws the road with a
//                                       kinked, wobbling outline where the direct
//                                       arm and the Mercator control both draw a
//                                       clean straight band — the windowed bake
//                                       quantizes a boundary crossing several
//                                       512-texel windows into stair steps.
//
// So direct still wins at 3.35 px: the budget is just above it. Its upper anchor
// is the shallow-source case that MUST keep draping — the maxzoom-2 mirror at
// z10.3 is 30.9 px of direct chord error, and the design doc records the engine's
// maxLevel-0 quads as having "no chord budget at all". Bracket (3.3, 25]; 4 is the
// tightest end, i.e. every camera measured direct-better stays direct.
//
// CONSERVATIVE BY CONSTRUCTION for the synthetic sources. The engine's earth-surface
// / polar-cap backends are a 128×64 lon/lat grid, not a subdivided z0 tile, so their
// real segment is 2.8125° where `tileSegmentAngleRad(0)` reports 11.25°. Pricing them
// by the tile rule overestimates their error 16×, which sends them to the drape
// EARLIER than they need — the safe direction, and the one that preserves what they
// do today.
import { tileSegmentAngleRad } from '@xgis/compiler'
import { TILE_PX } from '@xgis/geo'

/** Direct-path chord error (screen px) the drape is allowed to be preferable to.
 *  See the header for the two measurements that bracket it. */
export const GLOBE_DRAPE_CHORD_BUDGET_PX = 4

/** Screen-space deviation of the direct path's straight chords from the arcs they
 *  stand for, for tiles DRAWN at `drawnZ` under a camera at `cameraZoom`.
 *
 *  Worst case, deliberately: the equatorial tile width, and the sagitta taken
 *  unforeshortened (a limb-tangent edge). A tile facing the camera sees less. */
export function directChordErrorPx(drawnZ: number, cameraZoom: number): number {
  const rPx = (TILE_PX * 2 ** cameraZoom) / (2 * Math.PI)
  return rPx * (1 - Math.cos(tileSegmentAngleRad(drawnZ) / 2))
}

/** Whether the bake→drape path still wins for the globe's FILLS.
 *
 *  @param drawnZ     the LOD the tiles are actually drawn at (maxLevel-clamped —
 *                    the renderer passes `max(currentZ, targetZ)` so a zoom-in
 *                    readiness hold reads the camera's own level, not the held one)
 *  @param cameraZoom the camera's fractional zoom */
export function drapesAtChordBudget(drawnZ: number, cameraZoom: number): boolean {
  return directChordErrorPx(drawnZ, cameraZoom) > GLOBE_DRAPE_CHORD_BUDGET_PX
}
