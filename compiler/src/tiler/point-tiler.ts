// ═══ Vector Tiler: point per-geometry concern ═══
// Extracted verbatim from compileSingleTile's point branch. Bounds-checks the
// point in LL then projects to MM before pushing into the stride-3 point
// scratch — identical to the former inline body. DSFUN packing stays shared.

import { lonLatToMercF64 } from './ecef-packing'
import type { GeometryPart } from './vector-tiler-types'

/** LL tile bounds the point is range-checked against. */
export interface TileBoundsLL {
  west: number
  south: number
  east: number
  north: number
}

/** Scratch + accumulator surface a point part writes into. */
export interface PointTileScratch {
  ptv: number[]
}

/** Tile a single point GeometryPart into the shared scratch buffers.
 *  Logic identical to the former inline branch in compileSingleTile. */
export function tilePointPart(
  part: GeometryPart,
  fid: number,
  tb: TileBoundsLL,
  scratch: PointTileScratch,
  featureIds: Set<number>,
): void {
  const [px, py] = part.point!
  if (px >= tb.west && px <= tb.east && py >= tb.south && py <= tb.north) {
    const [pmx, pmy] = lonLatToMercF64(px, py)
    scratch.ptv.push(pmx, pmy, fid)
    featureIds.add(fid)
  }
}
