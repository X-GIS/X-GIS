import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'
import { lonLatToMercator } from '@xgis/data'
import { mercatorToECEFSphere } from '@xgis/shared'

// ═══ Flat Mercator display projection (projType 0) — FLATNESS gate ═══
//
// projection-display-layer-restore: ECEF is the DATA coordinate system, but
// the DISPLAY projection is separate. Flat Mercator must render a FLAT 2D
// plane, not a globe. Camera.getViewForProjection(0) returns the flat
// Mercator-metre MVP (no camera-centre translate); the vertex shaders feed
// camera-relative plane metres (project(abs) − cam).
//
// This gate locks the FLATNESS property at the camera-math level — the same
// assertion the SwiftShader render-position e2e makes, but fast + deterministic:
//   1. Points at the SAME latitude, spread across longitude, land at the SAME
//      screen-Y under the flat MVP (a globe would curve them).
//   2. Screen-X grows monotonically with longitude — the far points do NOT
//      collapse toward a horizon.
//   3. CONTRAST: the SAME points, projected as ECEF through the 3D ECEF MVP,
//      curve in screen-Y — proving the flat result is a real projection switch
//      over genuinely curved data, not coincident geometry.

const W = 800,
  H = 600,
  DPR = 1

// column-major mat4 (Float32Array(16)) × vec4(x,y,z,1) → NDC + clip-w.
function projectNdc(
  m: Float32Array,
  x: number,
  y: number,
  z: number,
): { ndcX: number; ndcY: number; w: number } {
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  return { ndcX: cx / cw, ndcY: cy / cw, w: cw }
}

describe('flat Mercator display projection (projType 0)', () => {
  const LAT = 20
  const LONS = [-20, -10, 0, 10, 20]

  function newCam(): Camera {
    const cam = new Camera(0, LAT, 2) // lon 0, lat 20, low zoom so ±20° is on-screen
    cam.bearing = 0
    cam.pitch = 0
    cam.globeMode = false
    return cam
  }

  it('flat MVP: same-latitude points share screen-Y (no globe curvature)', () => {
    const cam = newCam()
    const flat = cam.getViewForProjection(0, W, H, DPR)
    const { centerX, centerY } = cam
    const ndcY: number[] = []
    const ndcX: number[] = []
    for (const lon of LONS) {
      const [mx, my] = lonLatToMercator(lon, LAT)
      const p = projectNdc(flat.matrix, mx - centerX, my - centerY, 0)
      expect(p.w).toBeGreaterThan(0) // in front of the camera
      ndcY.push(p.ndcY)
      ndcX.push(p.ndcX)
    }
    // (1) FLATNESS: identical screen-Y across the whole longitude spread.
    const ySpread = Math.max(...ndcY) - Math.min(...ndcY)
    expect(ySpread).toBeLessThan(1e-4)
    // (2) Screen-X strictly increases with longitude — no horizon collapse.
    for (let i = 1; i < ndcX.length; i++) expect(ndcX[i]!).toBeGreaterThan(ndcX[i - 1]!)
    expect(ndcX[ndcX.length - 1]! - ndcX[0]!).toBeGreaterThan(0.1)
  })

  it('contrast: the SAME points curve in screen-Y under the 3D ECEF MVP', () => {
    const cam = newCam()
    const flat = cam.getViewForProjection(0, W, H, DPR)
    const ecef = cam.getECEFFrameView(W, H, DPR)
    const [ccx, ccy, ccz] = mercatorToECEFSphere(cam.centerX, cam.centerY)

    const flatY: number[] = []
    const ecefY: number[] = []
    for (const lon of LONS) {
      const [mx, my] = lonLatToMercator(lon, LAT)
      flatY.push(projectNdc(flat.matrix, mx - cam.centerX, my - cam.centerY, 0).ndcY)
      const [ex, ey, ez] = mercatorToECEFSphere(mx, my)
      ecefY.push(projectNdc(ecef.matrix, ex - ccx, ey - ccy, ez - ccz).ndcY)
    }
    const flatSpread = Math.max(...flatY) - Math.min(...flatY)
    const ecefSpread = Math.max(...ecefY) - Math.min(...ecefY)
    // The globe (ECEF) curves same-lat points in screen-Y; the flat plane does
    // not. The ECEF spread must dwarf the flat spread — proving the switch is
    // real and the data is genuinely curved.
    expect(flatSpread).toBeLessThan(1e-4)
    expect(ecefSpread).toBeGreaterThan(1e-3)
    expect(ecefSpread).toBeGreaterThan(flatSpread * 50)
  })

  it('selector routes projType 0 → flat MVP, 3D → ECEF MVP (distinct matrices)', () => {
    const cam = newCam()
    const flat = cam.getViewForProjection(0, W, H, DPR)
    const ecef = cam.getECEFFrameView(W, H, DPR)
    let maxDelta = 0
    for (let i = 0; i < 16; i++)
      maxDelta = Math.max(maxDelta, Math.abs(flat.matrix[i]! - ecef.matrix[i]!))
    expect(maxDelta).toBeGreaterThan(1e-6)
  })

  it('globeMode routes projType 0 to the 3D path (globe wins over flat)', () => {
    const cam = newCam()
    cam.globeMode = true
    const view = cam.getViewForProjection(0, W, H, DPR)
    const globe = cam.getECEFFrameView(W, H, DPR) // globeMode → _globeFrame
    let maxDelta = 0
    for (let i = 0; i < 16; i++)
      maxDelta = Math.max(maxDelta, Math.abs(view.matrix[i]! - globe.matrix[i]!))
    expect(maxDelta).toBeLessThan(1e-9)
  })

  it('Phase 2 selector: projTypes 0-6 use the flat MVP (≠ ECEF), 7 uses ECEF', () => {
    const cam = newCam() // globeMode = false
    const ecefM = Float32Array.from(cam.getECEFFrameView(W, H, DPR).matrix) // copy (buffer is reused)
    // 0..6 are flat — the matrix must differ from the 3D ECEF MVP.
    for (let pt = 0; pt <= 6; pt++) {
      const m = cam.getViewForProjection(pt, W, H, DPR).matrix
      let d = 0
      for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(m[i]! - ecefM[i]!))
      expect(d, `projType ${pt} must use the flat MVP, not ECEF`).toBeGreaterThan(1e-6)
    }
    // 7 (globe) — flat selector falls through to the ECEF MVP (globeMode=false
    // here selects the ECEF perspective branch, not _globeFrame).
    const m7 = cam.getViewForProjection(7, W, H, DPR).matrix
    let d7 = 0
    for (let i = 0; i < 16; i++) d7 = Math.max(d7, Math.abs(m7[i]! - ecefM[i]!))
    expect(d7, 'projType 7 must use the ECEF MVP').toBeLessThan(1e-9)
  })
})
