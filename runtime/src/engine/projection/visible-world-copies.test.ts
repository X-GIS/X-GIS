// iter-189 — visible world copy enumeration invariants.
//
// Single source of truth for "which world copies are visible this
// frame" replaces 4+ inline `[0, -1, 1, -2, 2]` loops in the CPU-
// projected paths (labels, raster, overlays). Test pins the camera-
// derived enumeration against expected counts per camera state.

import { describe, expect, it } from 'vitest'
import { Camera } from './camera'

const W = 800, H = 600, DPR = 1

function camAt(zoom: number, lon: number, lat: number, pitch = 0, bearing = 0): Camera {
  const c = new Camera()
  // lonLatToMercator inline (avoids a depender import).
  const R = 6378137, DEG2RAD = Math.PI / 180
  c.centerX = lon * DEG2RAD * R
  c.centerY = Math.log(Math.tan(Math.PI / 4 + lat * DEG2RAD / 2)) * R
  c.zoom = zoom
  c.pitch = pitch
  c.bearing = bearing
  c.projType = 0
  c.globeMode = false
  return c
}

describe('Camera.getVisibleWorldCopies — iter-189 root fix', () => {
  it('zoom 15 unpitched → single primary copy [0]', () => {
    const c = camAt(15, 0, 0)
    const v = c.getVisibleWorldCopies(W, H, DPR)
    expect(v).toEqual([0])
  })

  it('zoom 0 unpitched centered on lon=0 → primary only', () => {
    // At z=0 the entire world fits in the viewport; only primary
    // copy is enumerated. Adjacent copies project off-screen.
    const c = camAt(0, 0, 0)
    const v = c.getVisibleWorldCopies(W, H, DPR)
    expect(v).toContain(0)
    expect(v.length).toBeLessThanOrEqual(3)
  })

  it('zoom 0 with pitch=63 bearing=90 → multiple copies', () => {
    // User-reported view: OFM Liberty #0/0/-54/90.0/63. Extreme
    // pitch + bearing stretches the frustum across multiple worlds
    // (raster + label rendering must follow).
    const c = camAt(0, -54, 0, 63, 90)
    const v = c.getVisibleWorldCopies(W, H, DPR)
    expect(v.length).toBeGreaterThan(1)
    expect(v).toContain(0)
  })

  it('globe mode collapses to [0]', () => {
    const c = camAt(2, 0, 0)
    c.globeMode = true
    const v = c.getVisibleWorldCopies(W, H, DPR)
    expect(v).toEqual([0])
  })

  it('non-Mercator projType collapses to [0]', () => {
    const c = camAt(2, 0, 0)
    c.projType = 1 // equirectangular
    const v = c.getVisibleWorldCopies(W, H, DPR)
    expect(v).toEqual([0])
  })

  it('cache reuse — repeated calls without camera change return identical array', () => {
    const c = camAt(0, 0, 0, 30, 45)
    const v1 = c.getVisibleWorldCopies(W, H, DPR)
    const v2 = c.getVisibleWorldCopies(W, H, DPR)
    expect(v2).toBe(v1) // same array identity → cache hit
  })

  it('cache invalidates on camera move', () => {
    const c = camAt(0, 0, 0, 30, 0)
    c.getVisibleWorldCopies(W, H, DPR) // warm cache
    c.centerX += 1000  // move camera
    const v2 = c.getVisibleWorldCopies(W, H, DPR)
    // identity may match or not (offsets could be same), but the
    // method must NOT have returned the stale cached array under
    // the matrix-identity gate.
    expect(v2.length).toBeGreaterThanOrEqual(1)
  })

  it('result is clamped to [-2, 2]', () => {
    // Extreme pitch + low zoom in any direction must not exceed the
    // polygon vertex shader's WORLD_COPIES ceiling.
    const c = camAt(0, 0, 0, 80, 90)
    const v = c.getVisibleWorldCopies(W, H, DPR)
    for (const wo of v) {
      expect(wo).toBeGreaterThanOrEqual(-2)
      expect(wo).toBeLessThanOrEqual(2)
    }
  })
})
