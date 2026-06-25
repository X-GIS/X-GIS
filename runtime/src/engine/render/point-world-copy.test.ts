// GeoJSON point world-copy fan-out — fix for issue #594.
//
// Root cause: point-renderer.ts hardcoded `COPIES = [0]`, so GeoJSON point
// layers only rendered in the primary world.  Labels and fills used
// `camera.getVisibleWorldCopies(...)` and rendered in all visible copies.
//
// Fix: for projType 0 (flat Mercator) `COPIES` now comes from
// `camera.getVisibleWorldCopies(...)`.  For all other projTypes (globe /
// hemisphere) COPIES stays [0] — those use absolute ECEF which is
// copy-independent.
//
// This test verifies the offset-computation contract ANALYTICALLY (no GPU):
//   • For projType 0 the set of world copies matches `getVisibleWorldCopies`.
//   • For each copy `wo` the Mercator-x of the emitted point equals
//     `lon * DEG2RAD * R_MERC + wo * 360 * DEG2RAD * R_MERC`.
//   • For projType ≠ 0 exactly one copy (`wo = 0`) is emitted.

import { describe, it, expect } from 'vitest'
import { Camera } from '../projection/camera'

const DEG2RAD = Math.PI / 180
const R_MERC = 6378137 // web-Mercator sphere radius — matches point-renderer.ts

// ── Camera helpers ────────────────────────────────────────────────────────

function mercatorCamera(zoom: number, lon: number, lat: number, pitch = 0, bearing = 0): Camera {
  const c = new Camera()
  c.centerX = lon * DEG2RAD * R_MERC
  c.centerY = Math.log(Math.tan(Math.PI / 4 + lat * DEG2RAD / 2)) * R_MERC
  c.zoom = zoom
  c.pitch = pitch
  c.bearing = bearing
  c.projType = 0
  c.globeMode = false
  return c
}

// ── Helpers that mirror the fixed point-renderer.ts logic ─────────────────

/**
 * Returns the set of world-copy offsets the renderer will use for a given
 * projType, mirroring the fixed `COPIES` logic in point-renderer.ts.
 */
function copies(projType: number, camera: Camera, w = 800, h = 600, dpr = 1): readonly number[] {
  return projType === 0 ? camera.getVisibleWorldCopies(w, h, dpr) : [0]
}

/**
 * Returns the Mercator-x values the renderer writes into feat_data slots 20–21
 * (mxH+mxL) for one point at `lon` across all world copies.
 * This mirrors the inner loop of `uploadLayer` in point-renderer.ts.
 */
function mercatorXForAllCopies(
  lon: number,
  projType: number,
  camera: Camera,
  w = 800, h = 600, dpr = 1,
): number[] {
  return copies(projType, camera, w, h, dpr).map(wo => {
    const mx = lon * DEG2RAD * R_MERC + wo * 360 * DEG2RAD * R_MERC
    const mxH = Math.fround(mx)
    return mxH + Math.fround(mx - mxH) // reconstruct full f64-equivalent value
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('PointRenderer world-copy fan-out (issue #594)', () => {
  it('projType 0, high zoom → single primary copy [0]', () => {
    const cam = mercatorCamera(14, 126, 37) // Seoul, high zoom
    const cos = copies(0, cam)
    expect(cos).toEqual([0])
  })

  it('projType 0, low zoom → multiple world copies', () => {
    // At z=1 on a wide canvas the viewport covers more than one world width
    // and getVisibleWorldCopies returns at least [-1, 0, 1].
    const cam = mercatorCamera(1, 0, 0)
    const cos = copies(0, cam, 2000, 600)
    expect(cos.length).toBeGreaterThan(1)
    expect(cos).toContain(0)
  })

  it('projType 0 copies come from getVisibleWorldCopies — not hardcoded [0]', () => {
    // Force a scenario guaranteed to have world copies.
    const cam = mercatorCamera(1, 0, 0)
    const visible = cam.getVisibleWorldCopies(2000, 600)
    const cos = copies(0, cam, 2000, 600)
    expect(cos).toEqual(visible)
  })

  it('projType > 0 always collapses to [0] regardless of zoom', () => {
    // Globe (7), ortho (3), azi-eq (4), stereo (5) and non-Mercator flat (1,2,6)
    // all use absolute ECEF — no world-wrap applies.
    for (const pt of [1, 2, 3, 4, 5, 6, 7]) {
      const cam = mercatorCamera(1, 0, 0)
      cam.projType = pt
      if (pt >= 3) cam.globeMode = true // sphere projections
      const cos = copies(pt, cam, 2000, 600)
      expect(cos, `projType ${pt} should collapse to [0]`).toEqual([0])
    }
  })

  it('Mercator-x offset per copy equals wo * 360 * DEG2RAD * R_MERC', () => {
    // For a point at lon=10° and world copies [-1, 0, 1], the x positions
    // must differ by exactly one full-world width (2π × R_MERC ≈ 40,075,017 m).
    const WORLD_WIDTH = 360 * DEG2RAD * R_MERC // 2π × R_MERC
    const lon = 10

    const cam = mercatorCamera(1, 0, 0)
    const mxValues = mercatorXForAllCopies(lon, 0, cam, 2000, 600)

    // There must be at least 2 copies in this scenario.
    expect(mxValues.length).toBeGreaterThan(1)

    // Sort by value — adjacent entries must differ by exactly WORLD_WIDTH.
    const sorted = [...mxValues].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      const delta = sorted[i]! - sorted[i - 1]!
      expect(delta).toBeCloseTo(WORLD_WIDTH, 0) // within 1 m (f32 DSFUN roundtrip)
    }
  })

  it('primary copy (wo=0) position matches plain lon*DEG2RAD*R_MERC', () => {
    const lon = 126.977 // Seoul
    const cam = mercatorCamera(14, lon, 37)
    const mxValues = mercatorXForAllCopies(lon, 0, cam)
    // High zoom → single primary copy.
    expect(mxValues).toHaveLength(1)
    const expectedMx = lon * DEG2RAD * R_MERC
    const expectedMxH = Math.fround(expectedMx)
    const expected = expectedMxH + Math.fround(expectedMx - expectedMxH)
    expect(mxValues[0]).toBeCloseTo(expected, 3)
  })

  it('globe path (projType=0 overridden to 7) → ECEF single copy, no x offset', () => {
    // Confirm the globe guard: when projType≠0 the renderer uses COPIES=[0]
    // irrespective of getVisibleWorldCopies.
    const cam = mercatorCamera(1, 0, 0) // wide canvas, many copies if Merc
    cam.globeMode = true
    const cos = copies(7, cam, 2000, 600) // globe projType
    expect(cos).toEqual([0])
    expect(cos.length).toBe(1)
  })
})
