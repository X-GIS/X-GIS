// GeoJSON point world-copy fan-out — discriminating test for issue #594.
//
// Root cause: point-renderer.ts hardcoded `COPIES = [0]`, so GeoJSON point
// layers only rendered in the primary world.  Labels and fills used
// `camera.getVisibleWorldCopies(...)` and rendered in all visible copies.
//
// Fix: extracted two pure helpers from the render path:
//   • pointWorldCopies()  — COPIES derivation (isWebMercator gate)
//   • worldCopyMercX()    — per-copy Mercator-x offset formula
//
// This test imports those helpers DIRECTLY from point-renderer.ts so that
// reverting the fix (COPIES=[0] / dropping the wo offset) makes these tests
// FAIL.  The previous version re-implemented the helpers locally and was
// tautological.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/engine'
import { pointWorldCopies, worldCopyMercX } from '@xgis/map'

const DEG2RAD = Math.PI / 180
const R_MERC  = 6378137

// ── Camera helpers ────────────────────────────────────────────────────────

function mercatorCamera(zoom: number, lon: number, lat: number, pitch = 0, bearing = 0): Camera {
  const c = new Camera()
  c.centerX  = lon * DEG2RAD * R_MERC
  c.centerY  = Math.log(Math.tan(Math.PI / 4 + lat * DEG2RAD / 2)) * R_MERC
  c.zoom     = zoom
  c.pitch    = pitch
  c.bearing  = bearing
  c.projType = 0
  c.globeMode = false
  return c
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('pointWorldCopies (issue #594)', () => {
  it('projType 0, high zoom → single primary copy [0]', () => {
    const cam = mercatorCamera(14, 126, 37) // Seoul, high zoom
    expect(pointWorldCopies(0, cam, 800, 600, 1)).toEqual([0])
  })

  it('projType 0, low zoom → multiple world copies', () => {
    // At z=1 on a wide canvas the viewport covers more than one world width.
    const cam = mercatorCamera(1, 0, 0)
    const copies = pointWorldCopies(0, cam, 2000, 600, 1)
    expect(copies.length).toBeGreaterThan(1)
    expect(copies).toContain(0)
  })

  it('projType 0 copies come from getVisibleWorldCopies — not hardcoded [0]', () => {
    // Confirms the helper delegates to camera.getVisibleWorldCopies and is NOT
    // hardcoded.  Reverting COPIES=[0] in the helper breaks this assertion.
    const cam = mercatorCamera(1, 0, 0)
    const visible = cam.getVisibleWorldCopies(2000, 600, 1)
    expect(visible.length).toBeGreaterThan(1) // sanity: scenario actually has copies
    expect(pointWorldCopies(0, cam, 2000, 600, 1)).toEqual(visible)
  })

  it('projType > 0 always collapses to [0] regardless of zoom', () => {
    // Globe (7), ortho (3), azi-eq (4), stereo (5) and non-Mercator flat (1,2,6)
    // all use absolute ECEF — no world-wrap applies.
    for (const pt of [1, 2, 3, 4, 5, 6, 7]) {
      const cam = mercatorCamera(1, 0, 0)
      cam.projType = pt
      if (pt >= 3) cam.globeMode = true
      expect(
        pointWorldCopies(pt, cam, 2000, 600, 1),
        `projType ${pt} should collapse to [0]`,
      ).toEqual([0])
    }
  })
})

describe('worldCopyMercX (issue #594)', () => {
  it('wo=0 primary copy matches plain lon*DEG2RAD*R_MERC', () => {
    const lon = 126.977 // Seoul
    const expected = lon * DEG2RAD * R_MERC
    expect(worldCopyMercX(lon, 0)).toBeCloseTo(expected, 3)
  })

  it('adjacent copies differ by exactly one world-width', () => {
    const WORLD_WIDTH = 360 * DEG2RAD * R_MERC // 2π × R_MERC ≈ 40,075,017 m
    const lon = 10

    // Use the same copies the renderer would use at z=1 wide canvas.
    const cam = mercatorCamera(1, 0, 0)
    const copies = pointWorldCopies(0, cam, 2000, 600, 1)
    expect(copies.length).toBeGreaterThan(1) // sanity

    const mxValues = copies.map(wo => worldCopyMercX(lon, wo))
    const sorted = [...mxValues].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      const delta = sorted[i]! - sorted[i - 1]!
      expect(delta).toBeCloseTo(WORLD_WIDTH, 0) // within 1 m
    }
  })

  it('wo offset encodes isWebMercator gate: non-0 projType → single copy, zero offset', () => {
    // When projType≠0, pointWorldCopies returns [0] so worldCopyMercX is only
    // ever called with wo=0 — the offset term is zero.
    const lon = 45
    const mxNoOffset = worldCopyMercX(lon, 0)
    expect(mxNoOffset).toBeCloseTo(lon * DEG2RAD * R_MERC, 3)

    // A non-zero wo would produce a different value — confirming the formula
    // does carry the offset (and the gate in pointWorldCopies is what prevents
    // it from being applied for globe/hemisphere projections).
    const mxWithOffset = worldCopyMercX(lon, 1)
    expect(mxWithOffset).not.toBeCloseTo(mxNoOffset, 0)
  })
})
