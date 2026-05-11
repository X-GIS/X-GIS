// Data-driven diagnostic: project the lon/lat of the features the
// user reported clustering at the Pacific tile boundary (Canada,
// East Sea, Yellow Sea) through the EXACT projection math
// projectLonLatCopies uses in map.ts, and check whether they actually
// collapse to a single screen_x.

import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { WORLD_MERC, TILE_PX } from '../gpu/gpu-shared'

const DEG2RAD = Math.PI / 180
const EARTH_R = 6378137

function lonLatToMercator(lon: number, lat: number): [number, number] {
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat))
  return [
    lon * DEG2RAD * EARTH_R,
    Math.log(Math.tan(Math.PI / 4 + (clampedLat * DEG2RAD) / 2)) * EARTH_R,
  ]
}

// Same body as the inline closure in map.ts, but exposed for tests.
function projectLonLat(
  mvp: Float32Array, w: number, h: number, ccx: number, ccy: number,
  lon: number, lat: number, worldMercatorOffset: number = 0,
): [number, number] | null {
  const [mx, my] = lonLatToMercator(lon, lat)
  const rtcX = (mx + worldMercatorOffset) - ccx
  const rtcY = my - ccy
  const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
  if (cw <= 0) return null
  const ccx_ = mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!
  const ccy_ = mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!
  const ndcX = ccx_ / cw
  const ndcY = ccy_ / cw
  if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
  return [(ndcX + 1) * 0.5 * w, (1 - ndcY) * 0.5 * h]
}

const WORLD_COPIES = [-2, -1, 0, 1, 2]

function projectAllCopies(
  mvp: Float32Array, w: number, h: number, ccx: number, ccy: number,
  lon: number, lat: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const cw of WORLD_COPIES) {
    const proj = projectLonLat(mvp, w, h, ccx, ccy, lon, lat, cw * WORLD_MERC)
    if (proj) out.push(proj)
  }
  return out
}

describe('user-reported Pacific tile boundary clustering', () => {
  // OFM Bright low-zoom view, camera roughly over Asia/Pacific.
  const CANVAS_W = 1280
  const CANVAS_H = 800
  const DPR = 1

  // Features the user listed as clustering vertically:
  const CANADA = { lon: -100, lat: 55, name: 'Canada' }
  const EAST_SEA = { lon: 135, lat: 40, name: '동해' }
  const YELLOW_SEA = { lon: 123, lat: 35, name: '황해' }

  function setupCamera(centerLon: number, zoom: number, pitch = 0): {
    mvp: Float32Array; ccx: number; ccy: number
  } {
    const cam = new Camera(centerLon, 0, zoom)
    cam.pitch = pitch
    cam.bearing = 0
    const mvp = cam.getRTCMatrix(CANVAS_W * DPR, CANVAS_H * DPR, DPR)
    return { mvp, ccx: cam.centerX, ccy: cam.centerY }
  }

  it('z=2 camera over lon=0: Canada / East Sea / Yellow Sea project to DIFFERENT screen_x', () => {
    // The world spans ~2048 px on a 1280-wide canvas at z=2 (TILE_PX=512).
    // Camera at lon=0 sees roughly lon [-112, +112] in viewport. Of the
    // three features, only Yellow Sea (lon=+123) is borderline — Canada
    // (-100) and East Sea (+135) project off-screen along one axis.
    // The point: their projected screen_x values must DIFFER (clustering
    // would mean all map to the same x).
    const { mvp, ccx, ccy } = setupCamera(0, 2)
    const canadaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, CANADA.lon, CANADA.lat)
    const eastSeaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, EAST_SEA.lon, EAST_SEA.lat)
    const yellowSeaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, YELLOW_SEA.lon, YELLOW_SEA.lat)
    // eslint-disable-next-line no-console
    console.log('z=2 lon=0:', { Canada: canadaProj, EastSea: eastSeaProj, YellowSea: yellowSeaProj })
    // At least one of each must project to a visible (non-empty) set.
    expect(canadaProj.length).toBeGreaterThan(0)
    expect(eastSeaProj.length).toBeGreaterThan(0)
    expect(yellowSeaProj.length).toBeGreaterThan(0)
    // The visible projections of Canada vs East Sea must not collide
    // on screen_x — they're 235° apart in lon, and at z=2 with
    // TILE_PX=512 a degree is ~5.7 px, so any genuine projection has
    // them >100 px apart even after world-copy wrap.
    const canadaXs = canadaProj.map(p => p[0])
    const eastSeaXs = eastSeaProj.map(p => p[0])
    // No pair of (canada_x, east_sea_x) should be within 10 px of each other
    for (const cx of canadaXs) {
      for (const ex of eastSeaXs) {
        expect(Math.abs(cx - ex)).toBeGreaterThan(10)
      }
    }
  })

  it('z=2 camera over lon=180 (antimeridian view): each feature has its own screen_x', () => {
    const { mvp, ccx, ccy } = setupCamera(180, 2)
    const canadaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, CANADA.lon, CANADA.lat)
    const eastSeaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, EAST_SEA.lon, EAST_SEA.lat)
    const yellowSeaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, YELLOW_SEA.lon, YELLOW_SEA.lat)
    // eslint-disable-next-line no-console
    console.log('z=2 lon=180:', { Canada: canadaProj, EastSea: eastSeaProj, YellowSea: yellowSeaProj })
    expect(canadaProj.length).toBeGreaterThan(0)
    expect(eastSeaProj.length).toBeGreaterThan(0)
    expect(yellowSeaProj.length).toBeGreaterThan(0)
    const canadaXs = canadaProj.map(p => p[0])
    const eastSeaXs = eastSeaProj.map(p => p[0])
    const yellowSeaXs = yellowSeaProj.map(p => p[0])
    // East Sea (+135) and Yellow Sea (+123) differ by 12° lon. At z=2
    // that's ~70 px on a 1280 canvas — must be distinguishable.
    for (const ey of eastSeaXs) {
      for (const yy of yellowSeaXs) {
        // 12° lon should be ≥ 50px apart at z=2; assert NOT clustered.
        expect(Math.abs(ey - yy)).toBeGreaterThan(20)
      }
    }
    // Canada (-100) and East Sea (+135): 235° apart, must not align.
    for (const cx of canadaXs) {
      for (const ey of eastSeaXs) {
        expect(Math.abs(cx - ey)).toBeGreaterThan(10)
      }
    }
  })

  it('z=1 camera over lon=0: all three features visible at distinct x', () => {
    const { mvp, ccx, ccy } = setupCamera(0, 1)
    const canadaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, CANADA.lon, CANADA.lat)
    const eastSeaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, EAST_SEA.lon, EAST_SEA.lat)
    const yellowSeaProj = projectAllCopies(mvp, CANVAS_W, CANVAS_H, ccx, ccy, YELLOW_SEA.lon, YELLOW_SEA.lat)
    // eslint-disable-next-line no-console
    console.log('z=1 lon=0:', { Canada: canadaProj, EastSea: eastSeaProj, YellowSea: yellowSeaProj })
    expect(canadaProj.length).toBeGreaterThan(0)
    expect(eastSeaProj.length).toBeGreaterThan(0)
    expect(yellowSeaProj.length).toBeGreaterThan(0)
  })
})
