// ═══ INC-1 fail-first witness — the split-brain camera anchor (epic #1152) ═══
//
// Before INC-1, X-GIS carried TWO camera ECEF anchors:
//   • polygon TILE fill: the ELLIPSOID anchor (`computeTileCameraAnchor`, the
//     inline `cN = R/√(1−E2·sin²)` term — tile-camera-anchor.ts:82-90).
//   • point / heatmap / label: the SPHERE anchor (`cameraAnchorDsfun` →
//     `camera.getECEFCenter()` → `lonLatToECEFSphere`).
// The two anchors for the SAME camera lon/lat differ by the ellipsoid−sphere
// gap Δ(cam) = |lonLatToECEF − lonLatToECEFSphere|: 0 km @ equator, ~24.5 km @
// lat 60. A point feature and a polygon vertex at the SAME lon/lat, both fed
// through the SAME globe MVP, therefore land at clip positions that differ by
// `mvp · Δ(cam)` — thousands of px at z14 / pitch>0 (measured RED below), and
// identically zero at the equator (why the lat=0 parity gate never caught it).
//
// INC-1 moves `getECEFCenter` onto the ellipsoid, so the point anchor becomes
// byte-identical to the tile anchor (at |lat|<85.05, where the tile path's
// Merc-clamp is a no-op) → the two clips converge exactly.
//
// This test is the fail-first proof: it ASSERTS agreement, so it is RED on the
// pre-change (sphere) code and GREEN after `ecefCenterOf` → `lonLatToECEF`.
// MEASURED pre-change divergence @ lat 60, z14, pitch 45: see PRE-CHANGE note
// under each `it`.

import { describe, it, expect } from 'vitest'
import { Camera } from '../camera'
import { computeTileCameraAnchor, clampMercLat } from './tile-camera-anchor'
import { cameraAnchorDsfun } from './camera-anchor-dsfun'
import { lonLatToECEF } from '@xgis/shared'

const CANVAS_W = 1080
const CANVAS_H = 720
const DPR = 1

function mulMat4Vec4(
  m: Float32Array | ArrayLike<number>,
  v: [number, number, number, number],
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let r = 0; r < 4; r++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + r] * v[k]
    out[r] = s
  }
  return out
}

/** Reconstruct the clip position of a feature at (featLon, featLat) through
 *  BOTH camera-anchor paths, plus the ECEF anchor divergence. */
function reconstruct(camLon: number, camLat: number, featLon: number, featLat: number) {
  const cam = new Camera(camLon, camLat, 14)
  cam.pitch = 45
  cam.bearing = 0
  cam.globeMode = true
  cam.projType = 7

  const mvp = new Float32Array(cam.getECEFFrameView(CANVAS_W, CANVAS_H, DPR).matrix)
  const featureEcef = lonLatToECEF(featLon, featLat)

  // ── polygon TILE path anchor (ellipsoid, via computeTileCameraAnchor) ──
  // The tile SW corner: the feature's own tile is irrelevant to the anchor
  // divergence (which depends only on cam lon/lat), so use a nearby corner.
  const tileWest = camLon - 0.02
  const tileSouth = camLat - 0.02
  const a = computeTileCameraAnchor(tileWest, tileSouth, 0, camLon, camLat)
  const camOff: [number, number, number] = [
    a.ecefXH + a.ecefXL,
    a.ecefYH + a.ecefYL,
    a.ecefZH + a.ecefZL,
  ]
  // tileEcefCenter = the same ellipsoid tile corner computeTileCameraAnchor uses
  // (R = semi-major, Merc-clamped south). camAnchor_tile = tileEcefCenter − off.
  const tileEcefCenter = lonLatToECEF(tileWest, clampMercLat(tileSouth))
  const camAnchorTile: [number, number, number] = [
    tileEcefCenter[0] - camOff[0],
    tileEcefCenter[1] - camOff[1],
    tileEcefCenter[2] - camOff[2],
  ]
  const clipPoly = mulMat4Vec4(mvp, [
    featureEcef[0] - camAnchorTile[0],
    featureEcef[1] - camAnchorTile[1],
    featureEcef[2] - camAnchorTile[2],
    1,
  ])

  // ── point / heatmap path anchor (via cameraAnchorDsfun → getECEFCenter) ──
  const pd = cameraAnchorDsfun(cam, 7)
  const camAnchorPoint: [number, number, number] = [
    pd.hi[0] + pd.lo[0],
    pd.hi[1] + pd.lo[1],
    pd.hi[2] + pd.lo[2],
  ]
  const clipPoint = mulMat4Vec4(mvp, [
    featureEcef[0] - camAnchorPoint[0],
    featureEcef[1] - camAnchorPoint[1],
    featureEcef[2] - camAnchorPoint[2],
    1,
  ])

  const anchorGapM = Math.hypot(
    camAnchorTile[0] - camAnchorPoint[0],
    camAnchorTile[1] - camAnchorPoint[1],
    camAnchorTile[2] - camAnchorPoint[2],
  )
  const pxX = ((clipPoly[0] / clipPoly[3] - clipPoint[0] / clipPoint[3]) * CANVAS_W) / 2
  const pxY = ((clipPoly[1] / clipPoly[3] - clipPoint[1] / clipPoint[3]) * CANVAS_H) / 2
  return { anchorGapM, clipDeltaPx: Math.hypot(pxX, pxY) }
}

describe('INC-1 camera-anchor split-brain — point↔polygon clip agreement', () => {
  it('lat 60: point and polygon at the SAME lon/lat land at the SAME clip position (<0.5px)', () => {
    // PRE-CHANGE (RED, measured): the sphere point anchor and ellipsoid tile
    // anchor diverge by 24506.6 m, projecting to 5697.5 px at z14 pitch 45.
    // POST-CHANGE (GREEN): sub-pixel (identical anchor → f32 round-trip only).
    const { clipDeltaPx } = reconstruct(127, 60, 127.03, 60.015)
    expect(clipDeltaPx).toBeLessThan(0.5)
  })

  it('lat 60: the two camera anchors are the SAME ellipsoid point (<1 m)', () => {
    // PRE-CHANGE (RED, measured): anchorGap = 24506.6 m (ellipsoid − sphere @
    // lat 60). POST-CHANGE (GREEN): 0 m — both paths are lonLatToECEF now.
    const { anchorGapM } = reconstruct(127, 60, 127.03, 60.015)
    expect(anchorGapM).toBeLessThan(1)
  })

  it('CONTROL — equator: the split-brain is invisible (both anchors coincide)', () => {
    // At lat 0, sinLat=0 → N=A, z=0 → ellipsoid == sphere EXACTLY. This cell is
    // green BEFORE and AFTER — the reason the lat=0 parity gate hid the bug.
    const { anchorGapM, clipDeltaPx } = reconstruct(0, 0, 0.03, 0.015)
    expect(anchorGapM).toBeLessThan(1e-6)
    expect(clipDeltaPx).toBeLessThan(0.5)
  })
})
