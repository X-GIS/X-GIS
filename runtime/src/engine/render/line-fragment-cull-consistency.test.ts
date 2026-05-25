// Workflow #2 baseline (line-renderer side).
//
// Polygon fragment cull (renderer.ts:151 `polygon_cos_c_fragment`)
// reads abs_merc_x/y as a forwarded varying. Line fragment cull
// (line-renderer.ts:774-779) reconstructs abs_merc per fragment as
// `in.world_local + tile.tile_origin_merc`, then runs the same
// inverse Web Mercator → needs_backface_cull. The two paths MUST
// produce bit-identical cull signals at the same lon/lat — otherwise
// strokes leak on the back of the globe (red pixel symptom for
// outlined polygons) while fills correctly discard, or vice-versa.

import { describe, expect, it } from 'vitest'
import { cosC, needsBackfaceCullWgsl } from '../shader-dsl/cpu-projections'

const EARTH_R = 6378137
const DEG2RAD = Math.PI / 180

// Polygon path: abs_merc_x/y forwarded as varying.
function polygonCull(absMercX: number, absMercY: number, pt: number, clon: number, clat: number): number {
  const absLon = absMercX / (DEG2RAD * EARTH_R)
  const latRad = 2 * Math.atan(Math.exp(absMercY / EARTH_R)) - Math.PI / 2
  const absLat = latRad / DEG2RAD
  return needsBackfaceCullWgsl(pt, absLon, absLat, clon, clat)
}

// Line path: tile-local world plus tile origin.
function lineCull(worldLocalX: number, worldLocalY: number, tileOriginX: number, tileOriginY: number, pt: number, clon: number, clat: number): number {
  const absMercX = worldLocalX + tileOriginX
  const absMercY = worldLocalY + tileOriginY
  const absLon = absMercX / (DEG2RAD * EARTH_R)
  const latRad = 2 * Math.atan(Math.exp(absMercY / EARTH_R)) - Math.PI / 2
  const absLat = latRad / DEG2RAD
  return needsBackfaceCullWgsl(pt, absLon, absLat, clon, clat)
}

function lonLatToMerc(lon: number, lat: number): [number, number] {
  const x = lon * DEG2RAD * EARTH_R
  const latRad = lat * DEG2RAD
  const y = EARTH_R * Math.log(Math.tan(Math.PI / 4 + latRad / 2))
  return [x, y]
}

describe('line vs polygon fragment-cull parity (workflow #2)', () => {
  it('globe (projType=7): line + polygon culls agree at every grid point', () => {
    const clon = 0, clat = 30
    // Sample tile origin = arbitrary non-zero (mid-Europe z=4 tile).
    const tileOriginX = 1.5e6
    const tileOriginY = 5e6
    for (let i = 0; i < 11; i++) {
      for (let j = 0; j < 11; j++) {
        const lon = -170 + (i / 10) * 340
        const lat = -80 + (j / 10) * 160
        const [absMercX, absMercY] = lonLatToMerc(lon, lat)
        const polyResult = polygonCull(absMercX, absMercY, 7, clon, clat)
        const lineResult = lineCull(
          absMercX - tileOriginX,
          absMercY - tileOriginY,
          tileOriginX,
          tileOriginY,
          7, clon, clat,
        )
        expect(Math.sign(lineResult), `line/poly mismatch at lon=${lon} lat=${lat}`).toBe(Math.sign(polyResult))
        // Also both must match the lon/lat cosC ground truth on globe.
        expect(Math.sign(polyResult)).toBe(Math.sign(cosC(lon, lat, clon, clat)))
      }
    }
  })

  it('orthographic (projType=3): line + polygon culls agree', () => {
    const clon = 127, clat = 37
    const tileOriginX = 1.4e7
    const tileOriginY = 4.4e6
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        const lon = -160 + (i / 9) * 320
        const lat = -75 + (j / 9) * 150
        const [absMercX, absMercY] = lonLatToMerc(lon, lat)
        const polyResult = polygonCull(absMercX, absMercY, 3, clon, clat)
        const lineResult = lineCull(
          absMercX - tileOriginX,
          absMercY - tileOriginY,
          tileOriginX,
          tileOriginY,
          3, clon, clat,
        )
        expect(lineResult).toBeCloseTo(polyResult, 4)
      }
    }
  })

  it('flat projections — both paths return ≥1 everywhere (no cull)', () => {
    const clon = 0, clat = 0
    for (const pt of [0, 1, 2, 6]) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          const lon = -150 + (i / 5) * 300
          const lat = -70 + (j / 5) * 140
          const [mx, my] = lonLatToMerc(lon, lat)
          expect(polygonCull(mx, my, pt, clon, clat)).toBeGreaterThanOrEqual(1)
          expect(lineCull(mx - 1e6, my - 2e6, 1e6, 2e6, pt, clon, clat)).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })
})
