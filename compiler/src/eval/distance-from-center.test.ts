// Witnesses for distanceFromCenterRatio (#2119) — pinned over the DOMAIN
// (multiple viewport shapes, multiple directions), not one sample. The
// half-diagonal-vs-half-width/half-height trap the module doc warns about
// is invisible on a square viewport, so every witness here that matters
// runs on a non-square one too.

import { describe, it, expect } from 'vitest'
import { distanceFromCenterRatio } from './distance-from-center'

describe('distanceFromCenterRatio (#2119)', () => {
  it('is 0 at dead centre — square, wide, and tall viewports', () => {
    expect(distanceFromCenterRatio(400, 400, 800, 800)).toBe(0)
    expect(distanceFromCenterRatio(800, 200, 1600, 400)).toBe(0)
    expect(distanceFromCenterRatio(200, 800, 400, 1600)).toBe(0)
  })

  it('is EXACTLY 1 at all four corners, regardless of aspect ratio', () => {
    // This is the half-diagonal witness: half-width-only or half-height-
    // only normalization gives a DIFFERENT number at each corner once the
    // viewport isn't square (see the two false-formula cases below) —
    // half-diagonal is the one formula every corner agrees on.
    for (const [w, h] of [
      [800, 800], // square
      [1600, 400], // wide (4:1)
      [400, 1600], // tall (1:4)
      [1920, 1080], // real-world 16:9
    ]) {
      for (const [ax, ay] of [
        [0, 0],
        [w!, 0],
        [0, h!],
        [w!, h!],
      ]) {
        expect(distanceFromCenterRatio(ax, ay, w!, h!)).toBeCloseTo(1, 10)
      }
    }
  })

  it('non-square viewport: edge-midpoint ratio is direction-dependent (the half-diagonal fingerprint)', () => {
    // Wide viewport (1600×400): the LEFT/RIGHT edge midpoints are much
    // farther from centre (as a fraction of the diagonal) than the
    // TOP/BOTTOM ones — because the diagonal is dominated by the wide
    // axis. A half-height-only formula would instead read exactly 1 at
    // top/bottom and 4 (800/200) at left/right; a half-width-only formula
    // would read exactly 1 at left/right and 0.25 at top/bottom. Neither
    // matches these numbers, which is the point of the witness.
    const w = 1600
    const h = 400
    const halfDiag = Math.hypot(w / 2, h / 2) // 824.6211...
    const leftMid = distanceFromCenterRatio(0, h / 2, w, h)!
    const topMid = distanceFromCenterRatio(w / 2, 0, w, h)!
    expect(leftMid).toBeCloseTo(w / 2 / halfDiag, 10) // 800/824.62 ≈ 0.9701
    expect(topMid).toBeCloseTo(h / 2 / halfDiag, 10) // 200/824.62 ≈ 0.2425
    expect(leftMid).toBeGreaterThan(topMid)
    expect(leftMid).toBeLessThan(1) // edge midpoints are never the corner
    expect(topMid).toBeGreaterThan(0)

    // Tall viewport (400×1600): the inequality mirrors exactly.
    const wT = 400
    const hT = 1600
    const leftMidT = distanceFromCenterRatio(0, hT / 2, wT, hT)!
    const topMidT = distanceFromCenterRatio(wT / 2, 0, wT, hT)!
    expect(topMidT).toBeGreaterThan(leftMidT)
    expect(leftMidT).toBeCloseTo(topMid, 10) // symmetric under w/h swap
    expect(topMidT).toBeCloseTo(leftMid, 10)
  })

  it('square viewport: all four edge midpoints agree with each other (no direction bias)', () => {
    const ratio = distanceFromCenterRatio(400, 0, 800, 800)!
    expect(distanceFromCenterRatio(0, 400, 800, 800)).toBeCloseTo(ratio, 10)
    expect(distanceFromCenterRatio(800, 400, 800, 800)).toBeCloseTo(ratio, 10)
    expect(distanceFromCenterRatio(400, 800, 800, 800)).toBeCloseTo(ratio, 10)
    // sqrt(2)/2 ≈ 0.7071 — the well-known square-viewport edge-midpoint ratio.
    expect(ratio).toBeCloseTo(Math.SQRT2 / 2, 10)
  })

  it('is monotone increasing outward along a ray, for several directions and viewport shapes', () => {
    for (const [w, h] of [
      [800, 800],
      [1600, 400],
      [400, 1600],
    ]) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [3, 1],
        [-2, 5],
      ]) {
        const cx = w! / 2
        const cy = h! / 2
        const samples = [0, 0.25, 0.5, 1, 1.5, 2.5, 5].map((t) =>
          distanceFromCenterRatio(cx + dx * t * 100, cy + dy * t * 100, w!, h!)!,
        )
        for (let i = 1; i < samples.length; i++) {
          expect(samples[i]).toBeGreaterThan(samples[i - 1]!)
        }
      }
    }
  })

  it('is >1 once the anchor is off-screen', () => {
    // Anchor placed exactly 2x past centre along the corner diagonal —
    // by construction dist = 2 × halfDiagonal, so ratio = 2 exactly,
    // regardless of viewport shape. (A point just past an EDGE midpoint
    // is NOT off-screen in this metric — edge midpoints read <1, see the
    // fingerprint test above — so this witness deliberately goes past a
    // CORNER, the only place ratio 1 actually sits.)
    for (const [w, h] of [
      [800, 800],
      [1600, 400],
      [400, 1600],
    ]) {
      const cx = w! / 2
      const cy = h! / 2
      expect(distanceFromCenterRatio(cx + w!, cy + h!, w!, h!)).toBeCloseTo(2, 10)
    }
    // A direct off-edge case: past the corner on a wide viewport.
    expect(distanceFromCenterRatio(-500, 400, 800, 800)).toBeGreaterThan(1)
  })

  it('returns null for non-finite anchor or viewport input', () => {
    expect(distanceFromCenterRatio(NaN, 0, 800, 800)).toBeNull()
    expect(distanceFromCenterRatio(0, Infinity, 800, 800)).toBeNull()
    expect(distanceFromCenterRatio(0, 0, NaN, 800)).toBeNull()
    expect(distanceFromCenterRatio(0, 0, 800, -Infinity)).toBeNull()
  })

  it('returns null for a degenerate (zero or negative) viewport', () => {
    expect(distanceFromCenterRatio(0, 0, 0, 800)).toBeNull()
    expect(distanceFromCenterRatio(0, 0, 800, 0)).toBeNull()
    expect(distanceFromCenterRatio(0, 0, -800, 800)).toBeNull()
  })
})
