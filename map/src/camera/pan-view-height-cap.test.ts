// #2322: camera.pan() (used by the inertia glide and the above-horizon drag
// fallback) must move the centre by the RENDERED screen scale — the capped
// `effectiveMpp` the frame is actually drawn at — not the raw
// `WORLD_MERC / TILE_PX / 2^zoom`. Above the view-height cap (z* ≈ 1.08 for
// mercator, z* ≈ 2.73 for ortho on a 1080px canvas) the two coincide; below
// it they diverge and pan() over-moved the map relative to the drag it
// continues (2.1x-6.6x too fast at z0).
import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'

const W = 1080,
  H = 1080
const EARTH_R = 6378137
const RAD2DEG = 180 / Math.PI

describe('#2322 — camera.pan uses the rendered (capped) scale in the sub-cap band', () => {
  // Mercator flat branch: pan() vs panToScreenAnchor (the anchored drag, MVP-based)
  for (const zoom of [0, 3]) {
    it(`mercator z${zoom}: delta-pan matches anchored drag for a 10 px rightward flick`, () => {
      const a = new Camera(20, 0, zoom)
      a.projType = 0
      a.globeMode = false
      a.pitch = 0
      a.bearing = 0
      const ax0 = a.centerX
      a.panToScreenAnchor(ax0, a.centerY, W / 2 + 10, H / 2, W, H)
      const dA = a.centerX - ax0

      const b = new Camera(20, 0, zoom)
      b.projType = 0
      b.globeMode = false
      b.pitch = 0
      b.bearing = 0
      const bx0 = b.centerX
      b.pan(10, 0, W, H, 1)
      const dB = b.centerX - bx0
      expect(
        Math.abs(dB / dA - 1),
        `mercator z${zoom}: pan moved ${dB.toFixed(0)} m, anchored drag ${dA.toFixed(0)} m (ratio ${(dB / dA).toFixed(2)})`,
      ).toBeLessThan(0.01)
    })
  }

  // Ortho disc (sphere family, lat-deg branch): pan() vs the on-screen scale
  // measured through unprojectToZ0 (the same MVP the frame renders with).
  for (const zoom of [0, 3]) {
    it(`ortho z${zoom}: 10 px downward delta-pan moves the centre by the on-screen 10 px`, () => {
      const cam = new Camera(20, 0, zoom)
      cam.projType = 3
      cam.globeMode = false
      cam.pitchLocked = true
      cam.pitch = 0
      cam.bearing = 0
      const p0 = cam.unprojectToZ0(W / 2, H / 2, W, H, 1)!
      const p1 = cam.unprojectToZ0(W / 2, H / 2 + 10, W, H, 1)!
      expect(p0).not.toBeNull()
      expect(p1).not.toBeNull()
      const screenMpp = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 10
      const lat0 = cam.centerLatDeg
      cam.pan(0, 10, W, H, 1)
      const dLat = cam.centerLatDeg - lat0
      const expected = ((10 * screenMpp) / EARTH_R) * RAD2DEG
      expect(
        Math.abs(dLat / expected - 1),
        `ortho z${zoom}: pan moved centre ${dLat.toFixed(3)}°, screen 10 px = ${expected.toFixed(3)}° (ratio ${(dLat / expected).toFixed(2)}; screen mpp ${screenMpp.toFixed(0)})`,
      ).toBeLessThan(0.01)
    })
  }
})
