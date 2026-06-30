// Camera ECEF-MVP tests (Phase 2 PR 2c.1 — AC2c.1.4).
//
// Verifies the new `getECEFFrameView` matrix builder. At lat=0 the dual
// paths (legacy Mercator-DSFUN MVP × Mercator-relative vertex vs new
// ENU-MVP × ECEF-RTC vertex) converge mathematically — cos(0)=1, so
// altitude_true == altitude_mercator and the only residual difference
// is the curvature term (ECEF point lies on the curved ellipsoid, not
// the tangent plane at the camera anchor). This file is the precision
// floor; the 24-cell latitude-parity test in
// `polygon-ecef-mvp-latitude-parity.test.ts` is the correctness gate.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/engine'
import { mercatorToECEFSphere } from '@xgis/engine'
import { WORLD_MERC, TILE_PX } from '@xgis/engine'

// Apply column-major 4x4 to a vec4 → vec4.
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

describe('Camera.getECEFFrameView — equator-baseline parity (lat=0)', () => {
  it('1000 random z=14 tile-extent vertices: clip-space delta ≤ 0.05 px between legacy and ECEF paths', () => {
    // Camera at lon=0, lat=0, zoom=14. At lat=0 cos(0)=1, so the dual paths
    // converge mathematically — the only residual is the curvature term
    // (the ECEF point of a Mercator-plane vertex has a small Up component,
    // ~(dx²+dy²)/(2R) at z=14 ≈ 0.23 m worst case at the tile-extent corner).
    // That Up offset projects to ~0.016 px at altitude ~5141 m (z=14, 720 h).
    // Threshold 0.05 px = 3× margin over the mathematical floor; tighter
    // values would assert against geometry, not implementation.
    const cam = new Camera(0, 0, 14)
    cam.bearing = 0
    cam.pitch = 0
    const canvasW = 1080
    const canvasH = 720
    const dpr = 1

    const legacyMatrix = cam.getFrameView(canvasW, canvasH, dpr).matrix
    // Snapshot legacy matrix because getECEFFrameView may share static
    // temporaries; copy to plain Float32Array to be safe.
    const legacy = new Float32Array(legacyMatrix)
    const ecefMatrix = cam.getECEFFrameView(canvasW, canvasH, dpr).matrix
    const ecef = new Float32Array(ecefMatrix)

    // z=14 tile extent in Mercator metres.
    const tileExtent = WORLD_MERC / Math.pow(2, 14)
    const ecefCenter = cam.getECEFCenter()

    let maxDeltaPx = 0
    for (let i = 0; i < 1000; i++) {
      // Random Mercator-meter vertex within z=14 tile extent around the camera.
      const dx = (Math.random() - 0.5) * tileExtent
      const dy = (Math.random() - 0.5) * tileExtent

      // Legacy: vertex is (mx - cx, my - cy, 0) in Mercator metres.
      const clipLegacy = mulMat4Vec4(legacy, [dx, dy, 0, 1])

      // ECEF: compute ECEF of the absolute Mercator point, subtract camera
      // ECEF anchor → ecef_rtc. ECEF anchor lives in f64; subtraction here
      // mirrors the per-tile DSFUN-split that the VS will do in production.
      const mx = cam.centerX + dx
      const my = cam.centerY + dy
      const ecefVertex = mercatorToECEFSphere(mx, my, 0)
      const ex = ecefVertex[0] - ecefCenter[0]
      const ey = ecefVertex[1] - ecefCenter[1]
      const ez = ecefVertex[2] - ecefCenter[2]
      const clipEcef = mulMat4Vec4(ecef, [ex, ey, ez, 1])

      // Clip-space (x/w, y/w) → px via canvas/2 factor.
      const lx = clipLegacy[0] / clipLegacy[3]
      const ly = clipLegacy[1] / clipLegacy[3]
      const nx = clipEcef[0] / clipEcef[3]
      const ny = clipEcef[1] / clipEcef[3]
      const dpx = ((lx - nx) * canvasW) / 2
      const dpy = ((ly - ny) * canvasH) / 2
      const delta = Math.hypot(dpx, dpy)
      if (delta > maxDeltaPx) maxDeltaPx = delta
    }
    expect(maxDeltaPx).toBeLessThanOrEqual(0.05)
  })
})

describe('Camera.getECEFFrameView — globe-mode bypass', () => {
  it('returns the existing _globeFrame matrix when globeMode=true', () => {
    const cam = new Camera(126.97797, 37.56583, 4)
    cam.globeMode = true
    const ecefView = cam.getECEFFrameView(1080, 720, 1)
    const globeView = cam.getFrameView(1080, 720, 1) // also routed via _globeFrame
    // Both routes through _globeFrame return the same orbit-camera matrix.
    for (let i = 0; i < 16; i++) {
      expect(ecefView.matrix[i]).toBeCloseTo(globeView.matrix[i], 6)
    }
    expect(ecefView.far).toBeCloseTo(globeView.far, 3)
  })
})

describe('Camera.getECEFFrameView — backing-buffer discipline', () => {
  it('owns a separate backing buffer from getFrameView', () => {
    const cam = new Camera(0, 0, 14)
    cam.bearing = 0
    cam.pitch = 0
    const legacy = cam.getFrameView(1080, 720, 1).matrix
    const ecef = cam.getECEFFrameView(1080, 720, 1).matrix
    // Architect P1 #8: independent backing stores so interleaved calls
    // don't overwrite each other.
    expect(ecef).not.toBe(legacy)
  })
})

describe('Camera.getECEFFrameView — cache hit on repeated identical call', () => {
  it('returns the same matrix reference on identical inputs (no rebuild)', () => {
    const cam = new Camera(126.97797, 37.56583, 14)
    cam.bearing = 0
    cam.pitch = 30
    const a = cam.getECEFFrameView(1080, 720, 1).matrix
    const snapshot = new Float32Array(a)
    const b = cam.getECEFFrameView(1080, 720, 1).matrix
    expect(b).toBe(a) // same backing buffer
    for (let i = 0; i < 16; i++) expect(b[i]).toBe(snapshot[i])
  })

  // Suppress unused-import warning under noUnusedLocals when TILE_PX
  // is not referenced in the suite. The import remains for symmetry
  // with the production builder.
  void TILE_PX
})
