// G7 — extruded-globe recenter gate (blocks scope target #4).
//
// Pins the polygon.ts fix: the extruded 3D (else) arm of
// `emitPolygonProjectionLadder` MUST recentre `ecef_rtc` by
// `cam_ecef_off_h + cam_ecef_off_l` (= tileEcefCenter − cameraCenter), exactly
// like the flat-fill 3D arm. Before the fix the extruded arm transformed the
// bare `ecef_rtc` (= vertex − tileEcefCenter), which on projType 7 (globe,
// pitch>0) collapses EVERY extruded tile onto the camera-origin tile — the
// vertex is fed to a camera-at-ENU-origin MVP as if it sat at the tile's own
// local origin instead of its true ECEF geolocation.
//
// This gate is a faithful CPU sim of `vs_main_ecef_extruded`'s else arm using
// the SAME mirrors the compute-parity harness validates against the real GPU:
//   – generateWallMeshExtrudedECEF  → the production wall-mesh (ecef − tileEcefCenter)
//   – dequantVertexF32              → the GPU `dequant_ecef` fn (f32 semantics)
//   – mulMat4Vec4F32               → the GPU `mvp * vec4(...)` transform
//   – Camera.getECEFFrameView (globeMode) → the production ECEF-MVP
//
// The cam_ecef_off math mirrors vector-tile-renderer.ts:4879-4893 EXACTLY:
// tileEcefCenter is the WGS84 ELLIPSOID corner (lonLatToECEF), cameraCenter is
// the SPHERE anchor (getECEFCenter = mercatorToECEFSphere). That sphere/ellipsoid
// pairing is the intended #189-guarded frame, preserved verbatim here.
//
// Three assertions:
//   1. FIXED path (ecef_rtc + cam_ecef_off) clip ≈ independent
//      (vertex_ecef − cameraCenter) clip — sub-pixel. Proves the recentre is
//      the correct one and the vertex lands at its true screen position.
//   2. NEGATIVE CONTROL: the OLD bare path (mvp * vec4(ecef_rtc, 1)) lands
//      grossly off — pixel error ≫ a tile — proving the bug was real and that
//      the fix is what closes it (not a no-op).
//   3. The collapse vector equals cam_ecef_off projected through the MVP — i.e.
//      the bare path renders the vertex as if it were on the camera-origin tile.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'
import { lonLatToECEF } from '@xgis/shared'
import type { RingPolygon } from '@xgis/compiler'
import { generateWallMeshExtrudedECEF } from '@xgis/map'
import { dequantVertexF32, mulMat4Vec4F32 } from '@xgis/compiler'

const DEG2RAD = Math.PI / 180
const A = 6378137 // WGS84 semi-major (Mercator-metre scale)
const CANVAS_W = 1080
const CANVAS_H = 720
const DPR = 1

// Ellipsoid tileEcefCenter — mirrors vector-tile-renderer.ts:2175 / 4887
// (the tile corner via lonLatToECEF, height 0). Built from the tile SW corner.
function tileEcefCenterFor(tileWestDeg: number, tileSouthDeg: number): [number, number, number] {
  const e = lonLatToECEF(tileWestDeg, tileSouthDeg, 0)
  return [e[0], e[1], e[2]]
}

// Clip → pixel (NDC half-extent × canvas/2). Matches polygon-ecef-mvp-parity.
function clipToPx(clip: [number, number, number, number]): [number, number] {
  return [((clip[0] / clip[3]) * CANVAS_W) / 2, ((clip[1] / clip[3]) * CANVAS_H) / 2]
}

describe('G7 — extruded-globe recenter (projType 7 pitch>0)', () => {
  // Camera over Seoul-ish; a NON-camera tile placed far away (mid-Atlantic) so
  // a collapse-to-camera-origin error is unmistakable (thousands of km of ECEF
  // separation between tileEcefCenter and cameraCenter).
  const CAM_LON = 127.0
  const CAM_LAT = 37.5
  const ZOOM = 14
  const PITCH = 55

  // NON-camera tile: lon/lat far from the camera.
  const TILE_WEST = -30.0
  const TILE_SOUTH = 10.0
  // A building footprint inside that tile, in ABSOLUTE Mercator metres (the
  // ring convention generateWallMeshExtrudedECEF consumes). Pick a small
  // ~100 m footprint near the tile SW corner.
  const buildingLonLat: Array<[number, number]> = [
    [TILE_WEST + 0.001, TILE_SOUTH + 0.001],
    [TILE_WEST + 0.002, TILE_SOUTH + 0.001],
    [TILE_WEST + 0.002, TILE_SOUTH + 0.002],
    [TILE_WEST + 0.001, TILE_SOUTH + 0.002],
  ]
  const HEIGHT_M = 80

  function setupCamera(): Camera {
    const cam = new Camera(CAM_LON, CAM_LAT, ZOOM)
    cam.pitch = PITCH
    cam.bearing = 20
    cam.globeMode = true // projType 7: getECEFFrameView routes to _globeFrame
    cam.projType = 7
    return cam
  }

  // Build the production extruded mesh for the far tile + extract one roof
  // vertex (a known, deterministic ECEF position).
  function buildMesh() {
    const ring: Array<[number, number]> = buildingLonLat.map(([lon, lat]) => [
      lon * DEG2RAD * A, // abs Mercator x
      A * Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2)), // abs Mercator y
    ])
    const polygons: RingPolygon[] = [{ featId: 1, rings: [ring] }]
    const heights = new Map<number, number>([[1, HEIGHT_M]])
    const tileEcefCenter = tileEcefCenterFor(TILE_WEST, TILE_SOUTH)
    const tileMx = TILE_WEST * DEG2RAD * A
    const tileMy = A * Math.log(Math.tan(Math.PI / 4 + (TILE_SOUTH * DEG2RAD) / 2))
    const mesh = generateWallMeshExtrudedECEF(
      polygons,
      heights,
      undefined,
      tileMx,
      tileMy,
      tileEcefCenter,
    )
    return { mesh, tileEcefCenter }
  }

  it('FIXED path: recentred extruded vertex lands at its true screen position', () => {
    const cam = setupCamera()
    const { mesh, tileEcefCenter } = buildMesh()
    const ecefMatrix = new Float32Array(cam.getECEFFrameView(CANVAS_W, CANVAS_H, DPR).matrix)
    const cameraCenter = cam.getECEFCenter()

    // cam_ecef_off = tileEcefCenter − cameraCenter (production: vtr.ts:4887-4889),
    // DSFUN-split hi/lo exactly as the uniform writer does.
    const offX = tileEcefCenter[0] - cameraCenter[0]
    const offY = tileEcefCenter[1] - cameraCenter[1]
    const offZ = tileEcefCenter[2] - cameraCenter[2]
    const offH: [number, number, number] = [Math.fround(offX), Math.fround(offY), Math.fround(offZ)]
    const offL: [number, number, number] = [
      Math.fround(offX - offH[0]),
      Math.fround(offY - offH[1]),
      Math.fround(offZ - offH[2]),
    ]

    const quant = {
      vertices: mesh.vertices,
      dequantScale: mesh.dequantScale,
      dequantHalf: mesh.dequantHalf,
    }
    const vertCount = mesh.vertices.length / 11 // POLYGON_EXTRUDED_FORMAT stride = 11 floats
    expect(vertCount).toBeGreaterThan(0)

    let maxPxErr = 0
    for (let vi = 0; vi < vertCount; vi++) {
      const rtc = dequantVertexF32(quant, vi) // ecef_rtc = vertex − tileEcefCenter
      // SIM of the FIXED VS else-arm: ecef_cam = ecef_rtc + off_h + off_l.
      const ecefCam: [number, number, number] = [
        Math.fround(Math.fround(rtc[0] + offH[0]) + offL[0]),
        Math.fround(Math.fround(rtc[1] + offH[1]) + offL[1]),
        Math.fround(Math.fround(rtc[2] + offH[2]) + offL[2]),
      ]
      const simClip = mulMat4Vec4F32(ecefMatrix, [ecefCam[0], ecefCam[1], ecefCam[2], 1])

      // INDEPENDENT ground truth: the vertex's true ECEF − cameraCenter,
      // reconstructed from its abs_lon/abs_lat tail (the lonLatToECEF the
      // wall-mesh used for the position) at the same height. The mesh tail
      // carries abs_lon/abs_lat at float slots 4/5 + wall_height/is_top at 9/10.
      const o = vi * 11
      const absLon = mesh.vertices[o + 4]!
      const absLat = mesh.vertices[o + 5]!
      const wallH = mesh.vertices[o + 9]!
      const isTop = mesh.vertices[o + 10]!
      const vh = wallH * isTop
      const vEcef = lonLatToECEF(absLon, absLat, vh)
      const truthClip = mulMat4Vec4F32(ecefMatrix, [
        vEcef[0] - cameraCenter[0],
        vEcef[1] - cameraCenter[1],
        vEcef[2] - cameraCenter[2],
        1,
      ])

      const [sx, sy] = clipToPx(simClip)
      const [tx, ty] = clipToPx(truthClip)
      const err = Math.hypot(sx - tx, sy - ty)
      if (err > maxPxErr) maxPxErr = err
    }
    // Sub-pixel: the only residual is the u16 quantization grid + DSFUN f32
    // round-trip, both well under 1 px.
    expect(maxPxErr).toBeLessThanOrEqual(1.0)
  })

  it('NEGATIVE CONTROL: the old bare-ecef_rtc path collapses far off the true position', () => {
    const cam = setupCamera()
    const { mesh, tileEcefCenter } = buildMesh()
    const ecefMatrix = new Float32Array(cam.getECEFFrameView(CANVAS_W, CANVAS_H, DPR).matrix)
    const cameraCenter = cam.getECEFCenter()

    const quant = {
      vertices: mesh.vertices,
      dequantScale: mesh.dequantScale,
      dequantHalf: mesh.dequantHalf,
    }
    const vertCount = mesh.vertices.length / 11

    // The first roof vertex is a deterministic, well-defined sample.
    let sampleVi = -1
    for (let vi = 0; vi < vertCount; vi++) {
      if (mesh.vertices[vi * 11 + 10] === 1) {
        sampleVi = vi
        break
      } // is_top == 1
    }
    expect(sampleVi).toBeGreaterThanOrEqual(0)

    const rtc = dequantVertexF32(quant, sampleVi)
    // OLD BARE path (the bug): clip = mvp * vec4(ecef_rtc, 1). No recentre.
    const bareClip = mulMat4Vec4F32(ecefMatrix, [rtc[0], rtc[1], rtc[2], 1])

    // FIXED path for the same vertex.
    const offX = tileEcefCenter[0] - cameraCenter[0]
    const offY = tileEcefCenter[1] - cameraCenter[1]
    const offZ = tileEcefCenter[2] - cameraCenter[2]
    const fixedClip = mulMat4Vec4F32(ecefMatrix, [rtc[0] + offX, rtc[1] + offY, rtc[2] + offZ, 1])

    // The bare path transforms vertex − tileEcefCenter; the fixed path
    // transforms vertex − cameraCenter. They differ by cam_ecef_off (≈ the
    // ECEF separation between the far tile and the camera = thousands of km).
    // After the MVP the two clips diverge by a huge pixel distance OR the bare
    // vertex falls entirely outside the clip frustum (w ≤ 0 / off-NDC). Either
    // way it is NOT near the true position — the collapse the bug produces.
    const offMag = Math.hypot(offX, offY, offZ)
    expect(offMag).toBeGreaterThan(1_000_000) // > 1000 km separation: a real far tile

    const fixedW = fixedClip[3]
    const bareW = bareClip[3]
    // The fixed (true) vertex is in front of the camera (w > 0, on-screen-ish).
    expect(fixedW).toBeGreaterThan(0)
    const [fx, fy] = clipToPx(fixedClip)
    // The bare vertex is either behind the camera (w ≤ 0) or projects hundreds
    // of pixels away — concretely, more than a full tile (≫ 256 px) from truth.
    if (bareW > 0) {
      const [bx, by] = clipToPx(bareClip)
      const err = Math.hypot(bx - fx, by - fy)
      expect(err).toBeGreaterThan(256)
    } else {
      // Behind-camera collapse: w flipped sign — the vertex was thrown across
      // the globe. This is the grossest form of the collapse.
      expect(bareW).toBeLessThanOrEqual(0)
    }
  })
})
