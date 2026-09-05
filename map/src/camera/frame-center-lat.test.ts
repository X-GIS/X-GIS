// #2315 / #2500 — the frame's RTC-centre latitude must follow the SAME
// authority the orbit matrix (buildGlobeFrame → centerLatDeg) and the
// point/label anchor (ecefCenterOf → centerLatDeg) read, for every projType.
//
// Fail-before witness for #2500: at whole-earth zoom the render loop's
// viewport-fit clamp pinned camera.centerY to the equator while centerLatDeg
// kept the true latitude, and the frame centre was derived from centerY — so
// every tile anchor sat at lat 0 and fills drew R·sin(lat) off points/labels
// (58 px at globe z0, lat 45). frameCenterLatOf reads centerLatDeg for the
// sphere family, so the two anchors coincide by construction.
import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/shared'
import { mercatorYToLat, EARTH_R } from '@xgis/geo'
import { frameCenterLatOf, ecefCenterOf } from './view-matrix'
import { computeTileCameraAnchor } from '../render/tile-camera-anchor'

const GLOBE = 7
const MERCATOR = 0
const ORTHO = 3
const mercY = (latDeg: number): number =>
  Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360)) * EARTH_R

describe('frameCenterLatOf — one centre-latitude authority per frame', () => {
  it('globe at whole-earth zoom: centerY pinned to the equator, frame centre stays the true latitude', () => {
    // The #2500 camera state: centerLatDeg = 45 with a Mercator mirror clamped to 0.
    const view = { centerX: 0, centerY: 0, centerLatDeg: 45 }
    expect(frameCenterLatOf(view, GLOBE)).toBe(45)
    expect(frameCenterLatOf(view, ORTHO)).toBe(45)
    // The old derivation is what the fill anchors used: lat 0.
    expect(mercatorYToLat(view.centerY)).toBe(0)
  })

  it('globe past the Mercator limit (#2315): reaches the true pole-ward latitude', () => {
    const my = mercY(85.051129)
    const view = { centerX: 0, centerY: my, centerLatDeg: 89 }
    expect(frameCenterLatOf(view, GLOBE)).toBe(89)
    // and is clamped to the sphere pole, never beyond
    expect(frameCenterLatOf({ ...view, centerLatDeg: 95 }, GLOBE)).toBe(90)
  })

  it('cylindrical family keeps the Mercator mirror (byte-identical to the old derivation)', () => {
    const my = mercY(37.5)
    const view = { centerX: 0, centerY: my, centerLatDeg: 37.5 }
    expect(frameCenterLatOf(view, MERCATOR)).toBe(mercatorYToLat(my))
    // …and stays inside the Mercator pole limit even if centerLatDeg strays
    expect(frameCenterLatOf({ ...view, centerLatDeg: 89 }, MERCATOR)).toBe(mercatorYToLat(my))
  })

  it('tile anchor built from the frame centre coincides with the point/label anchor (globe z0, lat 45)', () => {
    const view = { centerX: 0, centerY: 0, centerLatDeg: 45 }
    const lat = frameCenterLatOf(view, GLOBE)
    const a = computeTileCameraAnchor(-180, -85.051129, 0, 0, lat)
    // Reconstruct the camera ECEF the anchor subtracted: tile − off.
    const tile = lonLatToECEF(-180, -85.051129)
    const camX = tile[0] - (a.ecefXH + a.ecefXL)
    const camY = tile[1] - (a.ecefYH + a.ecefYL)
    const camZ = tile[2] - (a.ecefZH + a.ecefZL)
    const focus = ecefCenterOf(view)
    // f32 hi/lo split → sub-metre; the #2500 defect was 4,560 km.
    expect(Math.hypot(camX - focus[0], camY - focus[1], camZ - focus[2])).toBeLessThan(1)
  })

  it('tile anchor camera term is not Mercator-clamped (#2315, lat 89)', () => {
    const a = computeTileCameraAnchor(0, 85.051129, 0, 0, 89)
    const tile = lonLatToECEF(0, 85.051129)
    const cam = lonLatToECEF(0, 89)
    const camZ = tile[2] - (a.ecefZH + a.ecefZL)
    expect(Math.abs(camZ - cam[2])).toBeLessThan(1)
  })
})
