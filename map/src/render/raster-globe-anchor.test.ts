// Regression: the raster VS reconstructs each tile vertex on the WGS84
// ellipsoid (lonlat_to_ecef, E2≠0), so the camera RTC anchor it subtracts MUST
// be on the SAME ellipsoid. The renderer used camera.getECEFCenter() — the
// SPHERE (E2=0) — leaving the ellipsoid−sphere discrepancy (~21.5km at
// mid-latitude) on every vertex, which flew the raster sheet off the globe
// (real-GPU: red vector borders separated from the OSM raster at z8). This pins
// the anchor to the ellipsoid frame. Fails if the anchor reverts to the sphere.
import { describe, it, expect } from 'vitest'
import { rasterGlobeCamAnchor } from '@xgis/map'
import { lonLatToECEF } from '@xgis/shared'

describe('raster globe camera anchor — ellipsoid frame', () => {
  it('is the WGS84 ellipsoid ECEF (matches the tile vertices), not the sphere', () => {
    const lon = 127,
      lat = 35.68 // Tokyo-ish mid-latitude (max ellipsoid offset)
    const anchor = rasterGlobeCamAnchor(lon, lat)

    // Same frame as lonlat_to_ecef — the raster tile vertices.
    const ell = lonLatToECEF(lon, lat)
    expect(anchor[0]).toBeCloseTo(ell[0], 3)
    expect(anchor[1]).toBeCloseTo(ell[1], 3)
    expect(anchor[2]).toBeCloseTo(ell[2], 3)

    // And it is NOT the sphere: ~21.5km apart at this latitude. Hand-rolled
    // sphere so the assertion is independent of which sphere helper is used.
    const R = 6378137,
      D2R = Math.PI / 180
    const clat = Math.cos(lat * D2R),
      slat = Math.sin(lat * D2R)
    const sx = R * clat * Math.cos(lon * D2R)
    const sy = R * clat * Math.sin(lon * D2R)
    const sz = R * slat
    const gap = Math.hypot(anchor[0] - sx, anchor[1] - sy, anchor[2] - sz)
    expect(gap, 'anchor must be on the ellipsoid (≠ sphere)').toBeGreaterThan(20_000)
  })
})
