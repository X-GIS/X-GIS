// ═══ Coverage CRS — lon/lat ↔ the grid's own units (#1366) ═══
//
// A `CoverageHandle`'s `origin`/`spacing` are in its CRS's units, and `valueAt` indexes
// with them directly. For a geographic cell those units ARE degrees, so a lon/lat query
// works by accident of the units matching. For a real NOAA S-102 cell they are UTM
// metres, and the same lon/lat query lands far outside the grid — `valueAt(-75.75, 37.95)`
// on a metre-origin grid returns null, not a depth.
//
// So the transform lives here, and here ONLY, for one reason: `CoverageHandle`
// (coverage/format.ts) is deliberately proj4-FREE. It is on the render path, and a bundle
// that merely draws a colour-ramped coverage must not pull the projection library in.
// Anything that needs geography goes through this module instead, exactly as the drape's
// mesh does.

import proj4 from 'proj4'
import { resolveEPSG } from '../sources/epsg-defs'
import type { CoverageHandle } from './format'

/** CRS codes whose units are already degrees, so no transform is needed. */
export function isGeographicCRS(crs: string): boolean {
  return crs === 'EPSG:4326' || crs === 'EPSG:4979'
}

/** A lon/lat point in the coverage's OWN horizontal CRS units. Identity (and no proj4
 *  call at all) for a geographic cell, so the common path pays nothing. */
export function lonLatToCellUnits(
  crs: string,
  lon: number,
  lat: number,
): [x: number, y: number] {
  if (isGeographicCRS(crs)) return [lon, lat]
  return proj4('EPSG:4326', resolveEPSG(crs), [lon, lat]) as [number, number]
}

/** `handle.valueAt` for callers holding a LON/LAT — the CRS-aware value readout.
 *
 *  `CoverageHandle.valueAt` is unit-native by design (it indexes with the grid's own
 *  origin/spacing); this transforms the query first, so the same lon/lat works whether the
 *  cell is geographic or projected. Returns null outside the grid and NaN at a nodata
 *  cell, exactly as `valueAt` does.
 *
 *  The value itself is never transformed — a depth is returned verbatim, positive-down.
 *  Only the QUERY moves, which is what keeps this the exact readout authority for
 *  soundings rather than an interpolation of one. */
export function valueAtLonLat(
  handle: CoverageHandle,
  lon: number,
  lat: number,
  bandIndex: string | number = 0,
): number | null {
  const [x, y] = lonLatToCellUnits(handle.header.crs, lon, lat)
  return handle.valueAt(x, y, bandIndex)
}
