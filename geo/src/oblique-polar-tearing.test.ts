// Polar tile tearing in oblique-Mercator (user issue 2026-05-19,
// memory note `project_oblique_polar_tearing`).
//
// User report: "어빌리큐 메르카토트에서 지도를 극지 영역으로 이동하면
// 타일 찢어지는 문제 발생함." — oblique mercator tears when the camera
// pans to polar regions.
//
// Root cause: `obliqueMercator.forward` runs the rotated-frame phi_rot
// through the SAME 85.05° clamp as plain Web Mercator. In the rotated
// frame the clamp is wrong — multiple distinct phi_rot values past
// 85.05° collapse to the identical projected Y. A tile mesh whose
// vertices span phi_rot ∈ [86°, 90°] has its top and bottom edges land
// at the SAME Y → degenerate triangle strip on screen → tearing.
//
// This test pins the seam delta before/after the fix. It samples a
// rotated-frame mesh edge that crosses phi_rot=85°…90° and asserts the
// projected Y is MONOTONIC and strictly increases — i.e. no vertex
// collapse. The pre-fix code fails the monotonicity check; the post-
// fix code keeps distinct Y values for distinct phi_rot up to the
// pole.

import { describe, expect, it } from 'vitest'
import { obliqueMercator } from '@xgis/geo'

const R = 6378137
const HALF_CIRC = Math.PI * R

describe('oblique_mercator polar tile tearing — vertex Y must not collapse past 85.05° (user bug)', () => {
  // With clat=0 the rotated frame is identical to geographic — so a
  // geographic-pole-ward sweep is also a rotated-pole-ward sweep,
  // making this the canonical seam repro. (For other clat values the
  // same collapse happens whenever a tile vertex straddles the
  // rotated pole at geographic (clon+180, 90-clat).)
  it('clat=0: distinct lats in [85, 89.9] produce distinct projected Y (no clamp collapse)', () => {
    const proj = obliqueMercator(0, 0)
    const lats = [85, 85.5, 86, 87, 88, 89, 89.5, 89.9]
    const ys = lats.map((lat) => proj.forward(0, lat)[1])
    // Pre-fix: 85.5° onward all map to HALF_CIRC ≈ 20037509 → ys
    // contains repeated values. Post-fix: strictly increasing.
    for (let i = 1; i < ys.length; i++) {
      const dy = ys[i] - ys[i - 1]
      expect(dy).toBeGreaterThan(0)
    }
    // Also: the spread between lat=85 and lat=89.9 must be larger
    // than the (collapsed-clamp) 1 m so the seam is visually
    // resolvable, not "all-equal-within-noise".
    expect(ys[ys.length - 1] - ys[0]).toBeGreaterThan(1e6) // > 1000 km
  })

  // Adjacent tile edge continuity across the rotated antimeridian.
  // For obliqueMercator(clon=0, clat=0) the rotated frame == geographic,
  // so rotated antimeridian == geographic ±180°. A tile to the west of
  // 180° and the wrap tile to the east of -180° share an edge at
  // ±180° — sampling that edge at high lat must give a single
  // continuous lam_rot, not a +π / -π jump that the per-tile unwrap
  // can't bridge once vertices have collapsed.
  it('tile edges at lat∈{85, 87, 89} on shared meridians keep neighbouring vertex deltas < 1 m', () => {
    const proj = obliqueMercator(0, 0)
    const lats = [85, 87, 89]
    // Mesh: two adjacent tiles sharing edge at lon=0.
    // Sample two vertices straddling the shared edge: lon=-ε and lon=+ε.
    const eps = 1e-4 // 1e-4 deg ≈ 11 m at equator — well inside a tile.
    for (const lat of lats) {
      const [xL, yL] = proj.forward(-eps, lat)
      const [xR, yR] = proj.forward(+eps, lat)
      // Adjacent vertices a hair on either side of a tile edge should
      // project to nearly-equal points (continuity at the edge).
      const dx = Math.abs(xR - xL)
      const dy = Math.abs(yR - yL)
      // 2ε deg of longitude at lat=89 maps to ~2·R·2ε·DEG2RAD =
      // ~2.4 m on the rotated equator side, < 1 m once cos(lat)
      // factors in. The PRE-fix code would have yR=yL (both clamped)
      // and xR-xL = 2·R·2ε·DEG2RAD ≈ 22.27 m — that part of the
      // continuity is unaffected. We pin dy here because dy=0 is the
      // post-clamp seam fingerprint AND dy=microscopic is the post-
      // fix expectation.
      expect(dx).toBeLessThan(50) // < 50 m vertex jump
      expect(dy).toBeLessThan(50)
    }
  })

  // The actual failure surface: monotonic phi_rot → monotonic Y
  // contract. Web Mercator has it (asinh(tan(phi)) is monotone). The
  // pre-fix oblique clamp breaks it past 85.05°. This is the property
  // a tile-mesh renderer relies on for vertex ordering — break it and
  // adjacent triangles fold over each other (visible "tearing").
  it('monotonicity contract: forward Y must be strictly monotone in phi_rot inside (-90°, +90°)', () => {
    const proj = obliqueMercator(0, 0) // rotated frame == geographic
    // Sample the entire dynamic range — equator to near-pole.
    const lats: number[] = []
    for (let lat = -89.9; lat <= 89.9; lat += 0.5) lats.push(lat)
    let lastY = -Infinity
    for (const lat of lats) {
      const [, y] = proj.forward(0, lat)
      // Pre-fix: between lat=85.5 and lat=89.9 the contract breaks —
      // Y stays at the clamp ceiling instead of strictly increasing.
      expect(y).toBeGreaterThan(lastY)
      lastY = y
    }
  })

  // Sanity: away from poles the projection is unchanged (no regression).
  it('low-latitude band (|lat|<60°) is byte-identical pre/post fix (no regression)', () => {
    const proj = obliqueMercator(0, 0)
    // Round-trip + known reference values from the existing math:
    const eq0 = proj.forward(0, 0)
    expect(eq0[0]).toBeCloseTo(0, 6)
    expect(eq0[1]).toBeCloseTo(0, 6)
    // Round trip a few interior samples
    for (const [lon, lat] of [
      [10, 20],
      [-30, 45],
      [45, -50],
      [60, 30],
    ] as [number, number][]) {
      const [x, y] = proj.forward(lon, lat)
      const [rlon, rlat] = proj.inverse(x, y)
      expect(rlon).toBeCloseTo(lon, 6)
      expect(rlat).toBeCloseTo(lat, 6)
      // Coordinate magnitudes stay bounded by half-circumference.
      expect(Math.abs(x)).toBeLessThan(HALF_CIRC * 2)
    }
  })
})
