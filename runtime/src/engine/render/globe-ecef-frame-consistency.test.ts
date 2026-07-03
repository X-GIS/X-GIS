// Regression gate for the globe deep-zoom "blank tiles" bug.
//
// THE BUG: on the true 3D globe (projType 7), the camera-relative ECEF RTC
// offset packed per-tile in vector-tile-renderer.ts:
//
//     off = tileEcefCenter − cameraCenter
//
// computed `tileEcefCenter` on the WGS84 ELLIPSOID (matching the tiler's
// packECEFPolygonVertices anchor) but `cameraCenter` on the SPHERE (plain
// radius A, no flattening). That mixed basis baked the ELLIPSOID−SPHERE
// discrepancy (~21.5 km at Tokyo's latitude) straight into the offset. The
// per-pixel size of that error scales with zoom:
//     z1.5  → 0.8 px   (invisible — globe renders fine)
//     z8    → 69  px   (partial — "half black")
//     z14   → 4396 px  (the whole tile is thrown thousands of px off-screen)
// so deep-zoom globe tiles rendered completely blank even though selection +
// upload were correct (globeTilesSelected=20, uploadQueued→0, 1406 draw calls).
//
// THE FIX: compute BOTH terms on the SAME (ellipsoid) basis so `off` is a pure
// ellipsoid-frame delta. The ~21 km absolute offset cancels in the
// subtraction (tile + camera sit at nearly the same lat at deep zoom), leaving
// a small, frame-consistent residual.
//
// This test pins the CPU-side invariant the renderer relies on, using the
// shared ECEF helpers directly (the renderer's inline copy mirrors them).

import { describe, expect, it } from 'vitest'
import { lonLatToECEF, lonLatToECEFSphere } from '@xgis/shared'

// metres-per-pixel at a given web-mercator zoom (TILE_PX=512, WORLD_MERC=2πA).
const A = 6378137
const WORLD_MERC = 2 * Math.PI * A
const TILE_PX = 512
const mpp = (zoom: number): number => WORLD_MERC / TILE_PX / Math.pow(2, zoom)

// Distance between two ECEF points.
const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

// A camera focused on Tokyo with a tile whose corner is one z14 tile away
// (≈ a few km) — the deep-zoom field condition from the user bug.
const CAM_LON = 139.76,
  CAM_LAT = 35.68
const TILE_LON = 139.78,
  TILE_LAT = 35.66

describe('globe ECEF camera-relative RTC — frame consistency (deep-zoom blank fix)', () => {
  it('MIXED basis (ellipsoid tile − SPHERE camera) injects a ~21 km error that blanks z14', () => {
    // This reproduces the OLD (buggy) offset: the tile/camera difference is
    // tiny (~km), but mixing ellipsoid tile with sphere camera adds the
    // full ellipsoid−sphere offset of the focus point.
    const tileEll = lonLatToECEF(TILE_LON, TILE_LAT)
    const camSphere = lonLatToECEFSphere(CAM_LON, CAM_LAT)
    const offMixed = dist(tileEll, camSphere)

    // The intended (small) offset is just the tile↔camera separation.
    const camEll = lonLatToECEF(CAM_LON, CAM_LAT)
    const trueSep = dist(tileEll, camEll)

    // The mixed-basis offset is dominated by the ~21 km ellipsoid−sphere
    // gap, NOT the few-km tile separation.
    expect(offMixed).toBeGreaterThan(20_000)
    expect(offMixed - trueSep).toBeGreaterThan(20_000)

    // That error, in pixels at z14, throws the tile thousands of px
    // off the ~860 px viewport → blank.
    const errPxZ14 = (offMixed - trueSep) / mpp(14)
    expect(errPxZ14).toBeGreaterThan(2_000)
  })

  it('SAME basis (ellipsoid tile − ELLIPSOID camera) keeps the offset = the true tile separation', () => {
    // The fix: both terms on the ellipsoid. The ~21 km absolute offset
    // cancels; the offset equals the real tile↔camera separation (~km).
    const tileEll = lonLatToECEF(TILE_LON, TILE_LAT)
    const camEll = lonLatToECEF(CAM_LON, CAM_LAT)
    const offSame = dist(tileEll, camEll)

    // A one-z14-tile separation is only a few km.
    expect(offSame).toBeLessThan(5_000)

    // At z14 that is a few hundred pixels at most — on-screen, correct.
    const offPxZ14 = offSame / mpp(14)
    expect(offPxZ14).toBeLessThan(1_000)
  })

  it('the ellipsoid−sphere focus discrepancy scales with zoom exactly as the observed sweep', () => {
    // Pins WHY low-zoom globe always rendered while deep-zoom went blank:
    // the SAME physical ~21 km error is sub-pixel at low zoom and enormous
    // at deep zoom.
    const camEll = lonLatToECEF(CAM_LON, CAM_LAT)
    const camSphere = lonLatToECEFSphere(CAM_LON, CAM_LAT)
    const focusErr = dist(camEll, camSphere) // ~21.5 km at Tokyo

    expect(focusErr).toBeGreaterThan(20_000)
    expect(focusErr).toBeLessThan(23_000)

    // Sub-pixel at z1.5 (renders), large at z14 (blank) — monotonic.
    expect(focusErr / mpp(1.5)).toBeLessThan(2) // < 2 px → invisible
    expect(focusErr / mpp(8)).toBeGreaterThan(30) // tens of px → partial
    expect(focusErr / mpp(14)).toBeGreaterThan(2_000) // thousands → blank
  })

  it('equator has zero ellipsoid−sphere gap (globe always rendered there even at z14)', () => {
    // Control: at lat 0 the ellipsoid and sphere coincide, so the old
    // mixed-basis bug never manifested on the equator — matching the
    // observed lat-dependence of the blank.
    const eqEll = lonLatToECEF(0, 0)
    const eqSphere = lonLatToECEFSphere(0, 0)
    expect(dist(eqEll, eqSphere)).toBeLessThan(1e-6)
  })
})
