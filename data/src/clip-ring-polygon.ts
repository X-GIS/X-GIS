// Clip a RingPolygon to an axis-aligned window — the polygon half of the
// over-zoom sub-tile clip.
//
// `SubTileGenerator` already clips a parent tile's fill / line / outline /
// point geometry into each sub-tile's rectangle, but historically forwarded
// the parent's ORIGINAL `polygons` (the extrusion source rings) UNCLIPPED.
// The extruded-building upload path (upload-coordinator →
// generateWallMeshExtrudedECEF) re-tessellates walls from those rings per
// sub-tile, so every over-zoom child re-extruded the parent's ENTIRE polygon
// set → duplicate overlapping walls + z-fighting at deep zoom (#1082). This
// clips each RingPolygon to the child's window so a child carries only its
// own buildings.
//
// Reuses the canonical Sutherland-Hodgman rectangle clip (`clipPolygonToRect`
// — already the fill path's clipper in SubTileGenerator, and @xgis/data
// already depends on @xgis/compiler) rather than a second implementation.

import { clipPolygonToRect, type RingPolygon } from '@xgis/compiler'

/** Clip one RingPolygon to the axis-aligned window `[west, south, east,
 *  north]`, expressed in the SAME coordinate space as `poly.rings` — absolute
 *  Mercator metres for sub-tile polygons, matching the window the outline
 *  path clips its ring arcs against. Returns:
 *
 *   - `poly` unchanged when its outer ring's bbox is fully inside the window
 *     (no clip — exact vertices preserved; the common interior-building case),
 *   - `null` when the outer ring's bbox is fully outside (drop — nothing to
 *     extrude in this window),
 *   - a freshly-clipped RingPolygon for straddlers.
 *
 *  Hole semantics: the outer ring (`rings[0]`) is clipped first, so a
 *  clipped-away outer drops the whole polygon (a surviving hole must never be
 *  promoted to the outer). Each hole is then clipped independently and
 *  degenerate (<3 vertex) rings are dropped — `clipPolygonToRect` already
 *  enforces the ≥3 floor per ring. `featId` is preserved so the per-feature
 *  height / base Maps (featId-keyed) stay valid for the clipped piece.
 *
 *  bbox comparisons mirror the SubTileGenerator fill-path window test (strict
 *  `<`/`>` for fully-outside, `>=`/`<=` for fully-inside). */
export function clipRingPolygonToWindow(
  poly: RingPolygon,
  west: number,
  south: number,
  east: number,
  north: number,
): RingPolygon | null {
  if (poly.rings.length === 0) return null
  const outer = poly.rings[0]
  if (outer.length < 3) return null

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const [x, y] of outer) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  // Fully outside → drop.
  if (maxX < west || minX > east || maxY < south || minY > north) return null
  // Fully inside (holes ⊂ outer, so also inside) → keep unchanged.
  if (minX >= west && maxX <= east && minY >= south && maxY <= north) return poly

  // Straddler: clip the outer alone so a clipped-away outer drops the polygon;
  // holes are clipped only once the outer survives.
  const clippedOuter = clipPolygonToRect([outer], west, south, east, north)
  if (clippedOuter.length === 0) return null
  const rings: number[][][] = [clippedOuter[0]]
  for (let h = 1; h < poly.rings.length; h++) {
    const clippedHole = clipPolygonToRect([poly.rings[h]], west, south, east, north)
    if (clippedHole.length > 0) rings.push(clippedHole[0])
  }
  return { rings, featId: poly.featId }
}
