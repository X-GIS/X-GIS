// ═══ Where a coverage grid actually sits (#1272 E-④) ═══
//
// ONE derivation, because two callers now need it and a disagreement between them is not
// cosmetic: the renderer builds the drape's uniforms from these edges, and
// `getCoverage(id, at)` uses them to pick WHICH region of a mosaic answers for a point. A
// point judged inside by one and outside by the other returns a value from a domain that
// is not the one drawn there — the worst kind of wrong, because it looks plausible.

import { lonLatToCellUnits, type CoverageHandle } from '@xgis/data'

/** The grid's OUTER edges `[west, south, east, north]` in the grid's OWN CRS units —
 *  degrees for a geographic cell, metres for a projected one (#1366).
 *
 *  `header.origin` is the first cell's CENTRE (south-west, with positive `spacing`), so the
 *  outer edge lies half a cell beyond it — the half-cell is why this is worth naming rather
 *  than re-deriving: dropping it shrinks the domain by one cell and opens a gap between
 *  adjacent mosaic regions exactly where they should abut. */
export function coverageEdges(handle: CoverageHandle): [number, number, number, number] {
  const [originLon, originLat] = handle.header.origin
  const [dLon, dLat] = handle.header.spacing
  const [nLon, nLat] = handle.header.size
  const west = originLon - dLon / 2
  const south = originLat - dLat / 2
  return [west, south, west + nLon * dLon, south + nLat * dLat]
}

/** Whether `lon`/`lat` falls within the grid's outer edges.
 *
 *  Edge-INCLUSIVE, and deliberately so: NOAA's regional domains are published to abut, so a
 *  half-open test would leave a hairline of coordinates that no region claims. Overlap is
 *  the safe failure here — two regions both claiming a point resolves to the first-armed
 *  one, which is a defined answer; a gap resolves to `null`, which reads as "no data" over
 *  water that plainly has some. Covering is a bbox test, not a validity test: a point inside
 *  the envelope but over land still has no value, and `valueAt` is what reports that.
 *
 *  CRS-AWARE (#1366). The edges are in the grid's OWN units — degrees only for a geographic
 *  cell — so the QUERY is moved into those units rather than the edges into degrees, the
 *  same direction `valueAtLonLat` takes and for the same reason: one transform of a point
 *  instead of four of a rectangle, and no question about what a reprojected bbox means. On a
 *  real S-102 cell (UTM metres) the un-transformed test could never be true, so a mosaic of
 *  projected regions would answer `null` for every point inside it. */
export function coverageCovers(handle: CoverageHandle, lon: number, lat: number): boolean {
  const [w, s, e, n] = coverageEdges(handle)
  const [x, y] = lonLatToCellUnits(handle.header.crs, lon, lat)
  return x >= w && x <= e && y >= s && y <= n
}
