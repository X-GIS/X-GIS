import { describe, it, expect } from 'vitest'
import { lonLatToECEF, lonLatToECEFSphere, WGS84 } from '@xgis/shared'

// ═══ Sphere↔ellipsoid datum gap — the split INC-1 closed (#1152) ═══
//
// The tiler packs polygon/line/point vertices in WGS84 ELLIPSOID ECEF
// (vector-tiler.ts: N = A/sqrt(1-E2·sin²lat), ez = N·(1-E2)·sinLat — the same
// formula as runtime lonLatToECEF). Until #1152 INC-1 the camera anchor was
// SPHERE ECEF (Camera.getECEFCenter → lonLatToECEFSphere, E2=0), so the point/
// heatmap/label features rode a DIFFERENT datum than the polygon tiles — the
// split-brain camera anchor. This gap is 0 at the equator and ~24 km at
// mid-latitude, which is exactly the point↔polygon misalignment INC-1 removed.
//
// INC-1 moved getECEFCenter onto the ellipsoid (lonLatToECEF), so the camera
// frame == the vertex frame now. ADR-0002 had kept the sphere because an
// ellipsoid camera "blew 19/24 cells" of polygon-ecef-mvp-latitude-parity — but
// that gate built its vertices with the SPHERE forward (a non-production pair);
// with the production ellipsoid pair the gate converges within the derived
// ~1.7 px ellipsoid north-axis residual (see that test + the ADR addendum).
//
// This test now pins the MAGNITUDE of the retired gap: `frameDelta` compares
// the ellipsoid (lonLatToECEF — both frames now) against the pre-INC-1 sphere
// helper (lonLatToECEFSphere). The numbers are the size of the datum error INC-1
// eliminated, and the record that motivates INC-4's retirement of the sphere
// helper (once its production caller count reaches 0).

/** Distance between the WGS84 ellipsoid (lonLatToECEF — the unified vertex AND
 *  camera frame since INC-1) and the pre-INC-1 sphere helper (lonLatToECEFSphere)
 *  for the same lon/lat. Measures the datum gap INC-1 removed from the camera. */
function frameDelta(lon: number, lat: number): number {
  const e = lonLatToECEF(lon, lat, 0) // unified frame (ellipsoid)
  const s = lonLatToECEFSphere(lon, lat, 0) // retired sphere helper (pre-INC-1 camera)
  return Math.hypot(e[0] - s[0], e[1] - s[1], e[2] - s[2])
}

describe('sphere↔ellipsoid datum gap — the split INC-1 closed', () => {
  it('equator: ellipsoid and sphere coincide — why the lat=0 parity gate passed blind', () => {
    expect(frameDelta(0, 0)).toBeLessThan(1e-6)
    expect(frameDelta(45, 0)).toBeLessThan(1e-6)
    expect(frameDelta(180, 0)).toBeLessThan(1e-6)
  })

  it('pole: the pre-INC-1 sphere anchor sat ~A·f (~21.4 km) off the ellipsoid vertex', () => {
    const poleDelta = frameDelta(0, 90)
    const expected = WGS84.A * WGS84.F // |A − A(1−f)| = A·f on the z-axis
    expect(poleDelta).toBeGreaterThan(21_000)
    expect(poleDelta).toBeCloseTo(expected, 0) // ~21384 m
  })

  it('every non-equatorial latitude had a multi-km gap; peak is mid-latitude, NOT the pole', () => {
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
