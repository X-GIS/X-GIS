// ═══ Frame RTC centre latitude past the Mercator limit (#2315) ═══
//
// #2315: the frame's centre latitude was `mercatorYToLat(camera.centerY)`, which
// saturates at ±85.051129°, while the orbit matrix (`buildGlobeFrame`) and the
// point/label anchors (`Camera.getECEFCenter`) build their RTC origin from
// `camera.centerLatDeg` — the TRUE centre latitude the sphere family stores and
// which reaches ±90°. Every tile/raster/drape renderer anchors on the frame
// value, so a globe centre past 85.05° drew the whole tile sheet against an
// origin 441 km away from the one its own MVP expects (181 px of displacement
// from the symbol layer at lat 89, z5).
//
// Guards BOTH halves of the fix, at the single producer of each:
//   1. `frameCenterLatDeg` (render-loop-helpers.ts) — reads the centre through
//      `representsCenterAs`, like tile-selection-cache / tile-decision already do.
//   2. `computeTileCameraAnchor` (render/tile-camera-anchor.ts) — its CAMERA ECEF
//      term no longer Mercator-clamps the latitude (the TILE term still must:
//      tile corners live on the Mercator grid).

import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { frameCenterLatDeg } from './render-loop-helpers'
import { computeTileCameraAnchor } from './render/tile-camera-anchor'
import { rasterGlobeCamAnchor } from './render/raster-renderer'
import { mercatorYToLat, lonLatToMercator, representsCenterAs } from '@xgis/geo'
import { lonLatToECEF } from '@xgis/shared'

const GLOBE = 7
const MERC_LIMIT = 85.051129

/** Exactly what camera-controller.setCenter(0, lat) writes for the sphere family
 *  (camera-controller.ts:104-110): centerY saturates at the Mercator limit while
 *  centerLatDeg carries the true latitude. */
function globeCameraAt(lat: number, zoom: number): Camera {
  const cam = new Camera(0, Math.min(lat, MERC_LIMIT), zoom)
  cam.setProjection(GLOBE)
  cam.centerY = lonLatToMercator(0, Math.min(lat, MERC_LIMIT))[1]
  cam.centerLatDeg = lat
  return cam
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
}

/** Project an ECEF-relative vertex through a column-major mvp to CSS px. */
function toPx(m: Float32Array, rel: readonly number[], w: number, h: number): [number, number] {
  const x = rel[0]!,
    y = rel[1]!,
    z = rel[2]!
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  return [((cx / cw + 1) / 2) * w, ((1 - cy / cw) / 2) * h]
}

describe('#2315 — the frame RTC centre latitude is the one the MVP anchors on', () => {
  it('frameCenterLatDeg returns centerLatDeg when the projection represents its centre as lat-deg', () => {
    const cam = globeCameraAt(89, 5)
    expect(representsCenterAs(cam.projType)).toBe('lat-deg')
    expect(frameCenterLatDeg(cam)).toBeCloseTo(89, 6)
  })

  it('frameCenterLatDeg stays the Mercator-derived latitude for cylindrical projections', () => {
    for (const projType of [0, 1, 2, 6]) {
      const cam = new Camera(0, 62.5, 4)
      cam.setProjection(projType)
      expect(representsCenterAs(projType)).toBe('mercator-y')
      expect(frameCenterLatDeg(cam)).toBe(mercatorYToLat(cam.centerY))
    }
  })

  it('the tile camera ECEF anchor built from the frame centre coincides with getECEFCenter()', () => {
    for (const lat of [0, 45, 85, 86, 88, 89, 90]) {
      const cam = globeCameraAt(lat, 5)
      const a = computeTileCameraAnchor(0, 85, 0, 0, frameCenterLatDeg(cam))
      const tileCam = [
        a.camEcefXH + a.camEcefXL,
        a.camEcefYH + a.camEcefYL,
        a.camEcefZH + a.camEcefZL,
      ]
      const d = dist(tileCam, cam.getECEFCenter())
      expect(
        d,
        `centerLatDeg=${lat}: tile cam anchor is ${(d / 1000).toFixed(1)} km from getECEFCenter()`,
      ).toBeLessThan(1)
    }
  })

  it('computeTileCameraAnchor does not Mercator-clamp the CAMERA latitude on its ECEF term', () => {
    for (const camLat of [86, 89, 90, -89]) {
      const a = computeTileCameraAnchor(0, 85, 0, 0, camLat)
      const tileCam = [
        a.camEcefXH + a.camEcefXL,
        a.camEcefYH + a.camEcefYL,
        a.camEcefZH + a.camEcefZL,
      ]
      const d = dist(tileCam, lonLatToECEF(0, camLat))
      expect(
        d,
        `camLat=${camLat}: ${(d / 1000).toFixed(1)} km off lonLatToECEF(0,${camLat})`,
      ).toBeLessThan(1)
    }
  })

  it('computeTileCameraAnchor still Mercator-clamps the TILE ECEF term (tile corners are on the Mercator grid)', () => {
    const a = computeTileCameraAnchor(0, 90, 0, 0, 0)
    const tileEcef = [
      a.tileEcefXH + a.tileEcefXL,
      a.tileEcefYH + a.tileEcefYL,
      a.tileEcefZH + a.tileEcefZL,
    ]
    expect(dist(tileEcef, lonLatToECEF(0, MERC_LIMIT))).toBeLessThan(1)
  })

  it('the raster/hillshade/drape anchor built from the frame centre coincides with getECEFCenter()', () => {
    const cam = globeCameraAt(89, 5)
    const d = dist(rasterGlobeCamAnchor(0, frameCenterLatDeg(cam)), cam.getECEFCenter())
    expect(d, `raster anchor ${(d / 1000).toFixed(1)} km off`).toBeLessThan(1)
  })

  it('a vertex projected via the tile camera anchor lands where the orbit matrix puts it', () => {
    const W = 1080,
      H = 1080
    const cam = globeCameraAt(89, 5)
    const mvp = cam.getViewForProjection(GLOBE, W, H, 1).matrix
    const v = lonLatToECEF(0, 89.5)
    const c = cam.getECEFCenter()
    const a = computeTileCameraAnchor(0, 85, 0, 0, frameCenterLatDeg(cam))
    const tileCam = [
      a.camEcefXH + a.camEcefXL,
      a.camEcefYH + a.camEcefYL,
      a.camEcefZH + a.camEcefZL,
    ]
    const pRef = toPx(mvp, [v[0] - c[0], v[1] - c[1], v[2] - c[2]], W, H)
    const pTile = toPx(mvp, [v[0] - tileCam[0]!, v[1] - tileCam[1]!, v[2] - tileCam[2]!], W, H)
    const dpx = Math.hypot(pRef[0] - pTile[0], pRef[1] - pTile[1])
    expect(
      dpx,
      `tile sheet displaced ${dpx.toFixed(1)} px from the point/label frame (ref ${pRef.map((n) => n.toFixed(1))}, tile ${pTile.map((n) => n.toFixed(1))})`,
    ).toBeLessThan(0.5)
  })
})
