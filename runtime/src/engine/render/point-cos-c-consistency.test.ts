// Workflow #2 — point renderer back-face cull parity.
//
// Point shader (point-renderer.ts:100 `point_cos_c`) reconstructs
// abs_merc per vertex from rtc_merc + camera Mercator, then routes
// through `needs_backface_cull`. Polygon (renderer.ts:151) and line
// (line-renderer.ts:774) do the same reconstruction PER FRAGMENT
// from different inputs. All three must produce identical cull
// signals at the same lon/lat — otherwise points leak red pixels
// on the back of the globe while fills/strokes correctly cull, or
// vice-versa.

import { describe, expect, it } from 'vitest'
import { cosC, needsBackfaceCullWgsl } from '@xgis/shader-dsl'

const EARTH_R = 6378137
const DEG2RAD = Math.PI / 180
const MERCATOR_LAT_LIMIT = 85.0511287798066

function lonLatToMerc(lon: number, lat: number): [number, number] {
  const x = lon * DEG2RAD * EARTH_R
  const latRad = lat * DEG2RAD
  const y = EARTH_R * Math.log(Math.tan(Math.PI / 4 + latRad / 2))
  return [x, y]
}

// CPU port of WGSL point_cos_c.
function pointCosCCpu(rtcMercX: number, rtcMercY: number, projType: number, camLon: number, camLat: number): number {
  const clampedCamLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, camLat))
  const camMercX = camLon * DEG2RAD * EARTH_R
  const camMercY = Math.log(Math.tan(Math.PI / 4 + clampedCamLat * DEG2RAD / 2)) * EARTH_R
  const absMercX = rtcMercX + camMercX
  const absMercY = rtcMercY + camMercY
  const absLon = absMercX / (DEG2RAD * EARTH_R)
  const latRad = 2 * Math.atan(Math.exp(absMercY / EARTH_R)) - Math.PI / 2
  const absLat = latRad / DEG2RAD
  return needsBackfaceCullWgsl(projType, absLon, absLat, camLon, camLat)
}

describe('point_cos_c vs polygon/line fragment-cull parity (workflow #2)', () => {
  it('globe (projType=7): point culls match lon/lat cosC across grid', () => {
    const camLon = 0, camLat = 20
    const [camMercX, camMercY] = lonLatToMerc(camLon, camLat)
    for (let i = 0; i < 11; i++) {
      for (let j = 0; j < 11; j++) {
        const lon = -170 + (i / 10) * 340
        const lat = -80 + (j / 10) * 160
        const [absMercX, absMercY] = lonLatToMerc(lon, lat)
        const rtcX = absMercX - camMercX
        const rtcY = absMercY - camMercY
        const cull = pointCosCCpu(rtcX, rtcY, 7, camLon, camLat)
        const truth = cosC(lon, lat, camLon, camLat)
        expect(Math.sign(cull), `mismatch at lon=${lon} lat=${lat}: cull=${cull} truth=${truth}`)
          .toBe(Math.sign(truth))
      }
    }
  })

  it('orthographic (projType=3): point culls match ground truth', () => {
    const camLon = 127, camLat = 37
    const [camMercX, camMercY] = lonLatToMerc(camLon, camLat)
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) {
        const lon = -160 + (i / 9) * 320
        const lat = -75 + (j / 9) * 150
        const [absMercX, absMercY] = lonLatToMerc(lon, lat)
        const rtcX = absMercX - camMercX
        const rtcY = absMercY - camMercY
        const cull = pointCosCCpu(rtcX, rtcY, 3, camLon, camLat)
        const truth = cosC(lon, lat, camLon, camLat)
        expect(cull).toBeCloseTo(truth, 4)
      }
    }
  })

  it('antipodal points on globe always cull (red pixel guard)', () => {
    const camLon = 0, camLat = 0
    const [camMercX, camMercY] = lonLatToMerc(camLon, camLat)
    const antipodes: Array<[number, number]> = [[180, 0], [-180, 0], [175, 30], [-175, -45]]
    for (const [lon, lat] of antipodes) {
      const [absMercX, absMercY] = lonLatToMerc(lon, lat)
      const cull = pointCosCCpu(absMercX - camMercX, absMercY - camMercY, 7, camLon, camLat)
      expect(cull, `antipodal point (${lon},${lat}) NOT culled — back-face leak`).toBeLessThan(0)
    }
  })

  it('flat projections: point cull always ≥1 (no cull for cylindrical/flat)', () => {
    for (const pt of [0, 1, 2, 6]) {
      const camLon = 60, camLat = 25
      const [camMercX, camMercY] = lonLatToMerc(camLon, camLat)
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          const lon = -150 + (i / 5) * 300
          const lat = -70 + (j / 5) * 140
          const [absMercX, absMercY] = lonLatToMerc(lon, lat)
          const cull = pointCosCCpu(absMercX - camMercX, absMercY - camMercY, pt, camLon, camLat)
          expect(cull).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  it('camera lat clamp to MERCATOR_LAT_LIMIT applies (cam at pole survives)', () => {
    // WGSL clamps cam_lat into ±85.05° before computing cam_merc_y.
    // Test cam_lat outside the limit still produces finite cull values.
    for (const camLat of [89.5, -89.5, 90, -90]) {
      const camLon = 0
      const [absMercX, absMercY] = lonLatToMerc(0, 0) // pick equator point
      // CPU port mirrors the clamp.
      const cull = pointCosCCpu(absMercX, absMercY, 7, camLon, camLat)
      expect(Number.isFinite(cull)).toBe(true)
    }
  })
})
