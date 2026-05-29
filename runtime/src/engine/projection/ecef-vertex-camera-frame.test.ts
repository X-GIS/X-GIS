import { describe, it, expect } from 'vitest'
import { lonLatToECEF, lonLatToECEFSphere, WGS84 } from './ecef'

// ═══ Vertex(ellipsoid) ↔ camera(sphere) ECEF frame mismatch guard ═══
//
// The tiler packs polygon/line/point vertices in WGS84 ELLIPSOID ECEF
// (vector-tiler.ts: N = A/sqrt(1-E2·sin²lat), ez = N·(1-E2)·sinLat — the same
// formula as runtime lonLatToECEF). But the camera anchor is SPHERE ECEF
// (Camera.getECEFCenter → mercatorToECEFSphere, E2=0), which ecef.ts's
// lonLatToECEFSphere comment mandates "for parity with the legacy 2D Mercator
// MVP" and explicitly flags the ellipsoid as "breaking the dual-path parity
// gate" (~1.7px clip delta at z=14). Both frames were introduced in the same
// commit (#164).
//
// The existing parity gate (camera-ecef-mvp.test.ts) only checks lat=0, where
// ellipsoid == sphere EXACTLY (sinLat=0) — so the frame mismatch is invisible
// there and grows monotonically toward the poles (the original polar concern:
// X-GIS moved to ECEF for polar data, but vertex and camera disagree at the
// poles and that region is unverified).
//
// This guard pins the mismatch at known latitudes so it can't drift silently.
//
// RESOLVED — the mismatch is BY DESIGN, not a defect. Unifying the camera onto
// the ellipsoid (getECEFCenter → mercatorToECEF) was tried and reverted: it
// broke the ECEF-MVP ↔ legacy-Mercator convergence at 19/24 cells of
// polygon-ecef-mvp-latitude-parity (AC2c.1.5), i.e. the Mercator pixel-parity
// (AC1) that the sphere anchor exists to guarantee. The ~24 km measured here is
// an ABSOLUTE ECEF delta; over an RTC tile extent the tiler's ellipsoid vertices
// stay within ≤1.5 px of the sphere anchor (that parity test proves it). So the
// absolute-coordinate frame split is real but decoupled from render accuracy —
// the camera intentionally stays on the sphere for Mercator parity while
// vertices stay on the ellipsoid for eventual 3D-Tiles alignment. This guard
// now documents that intentional split; it would only need revisiting if a
// future change unifies the frames (which must NOT regress AC2c.1.5).

/** Distance between the vertex frame (tiler ellipsoid = lonLatToECEF) and the
 *  camera frame (sphere = lonLatToECEFSphere) for the same lon/lat. */
function frameDelta(lon: number, lat: number): number {
  const e = lonLatToECEF(lon, lat, 0)        // vertex frame (tiler ellipsoid)
  const s = lonLatToECEFSphere(lon, lat, 0)  // camera frame (sphere)
  return Math.hypot(e[0] - s[0], e[1] - s[1], e[2] - s[2])
}

describe('vertex(ellipsoid) ↔ camera(sphere) ECEF frame mismatch guard', () => {
  it('equator: ellipsoid and sphere coincide — why the lat=0 parity gate passes blind', () => {
    expect(frameDelta(0, 0)).toBeLessThan(1e-6)
    expect(frameDelta(45, 0)).toBeLessThan(1e-6)
    expect(frameDelta(180, 0)).toBeLessThan(1e-6)
  })

  it('pole: vertex sits ~A·f (~21.4 km) inside the camera sphere — the unchecked gap', () => {
    const poleDelta = frameDelta(0, 90)
    const expected = WGS84.A * WGS84.F // |A − A(1−f)| = A·f on the z-axis
    expect(poleDelta).toBeGreaterThan(21_000)
    expect(poleDelta).toBeCloseTo(expected, 0) // ~21384 m
  })

  it('every non-equatorial latitude has a multi-km gap; peak is mid-latitude, NOT the pole', () => {
    // Only lat=0 is clean — that single sample is exactly what the existing
    // lat=0 parity gate checks, which is why the mismatch hides from it.
    for (const lat of [15, 30, 45, 60, 75, 90]) {
      expect(frameDelta(0, lat)).toBeGreaterThan(5_000) // all > 5 km
    }
    // The gap is NON-monotonic: the horizontal (N−A)·cosLat component peaks at
    // mid-latitudes, so ~45° (~24 km) exceeds the pole (~21.4 km on the z-axis
    // alone). A naive "worst case at the poles" assumption is wrong.
    expect(frameDelta(0, 45)).toBeGreaterThan(frameDelta(0, 90))
  })
})
