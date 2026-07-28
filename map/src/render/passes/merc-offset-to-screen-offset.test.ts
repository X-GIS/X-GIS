// INC-2 of docs/plans/2026-07-27-line-label-world-anchored-placement.md.
//
// The line branches walk in SCREEN space but anchor in the WORLD, so a world
// offset (mercator arc-length) has to become an along-screen offset. INC-1 did
// that with a single `pxPerMeter` scalar, which is only correct where the
// mercator→screen ratio is constant along the run. It is not: under pitch the far
// end of a road compresses, and over a long low-zoom polyline the ratio drifts with
// latitude. These tests pin the prefix-sum mapping that replaces the scalar,
// starting with the cases where the scalar and the mapping visibly disagree.

import { describe, expect, it } from 'vitest'
import { mercOffsetToScreenOffset } from './place-labels-along-line'

/** Horizontal run: sample i at screen x = sx[i], mercator arc pm[i]. */
function run(sx: number[], pm: number[]) {
  return {
    px: new Float32Array(sx),
    py: new Float32Array(sx.map(() => 0)),
    pm: new Float64Array(pm),
    pn: sx.length,
  }
}

describe('mercOffsetToScreenOffset (INC-2)', () => {
  it('maps proportionally when the screen/mercator ratio is uniform', () => {
    // 400 screen px over 200 m ⇒ 2 px/m throughout.
    const r = run([0, 200, 400], [1000, 1100, 1200])
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 1000)).toBeCloseTo(0, 9)
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 1050)).toBeCloseTo(100, 9)
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 1200)).toBeCloseTo(400, 9)
  })

  it('follows a VARYING ratio — the case a single pxPerMeter gets wrong', () => {
    // Perspective compression: the first 100 m spans 300 px, the next 100 m only
    // 100 px. A scalar fit (400 px / 200 m = 2 px/m) would put the midpoint anchor
    // at 200 px; it actually falls at 300 px.
    const r = run([0, 300, 400], [0, 100, 200])
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 100)).toBeCloseTo(300, 9)
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 50)).toBeCloseTo(150, 9)
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 150)).toBeCloseTo(350, 9)
    // The scalar approximation would have said 200 / 100 / 300.
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 100)).not.toBeCloseTo(200, 1)
  })

  it('returns a NEGATIVE offset for an anchor behind the first retained sample', () => {
    // The tile entry normally sits in the MVT buffer, i.e. before the run starts.
    // pm[0] = 1000 means 1000 m of polyline was dropped before the first sample.
    const r = run([0, 200], [1000, 1100])
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 900)).toBeCloseTo(-200, 9)
  })

  it('extrapolates past the end instead of clamping', () => {
    // Clamping would collapse every off-run anchor onto the endpoint and quantise
    // the phase to a single value.
    const r = run([0, 200], [0, 100])
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 150)).toBeCloseTo(300, 9)
  })

  it('extrapolates the tail using the LAST interval, not the whole-run average', () => {
    const r = run([0, 300, 400], [0, 100, 200])
    // Last interval is 100 px / 100 m ⇒ 50 m past the end is +50 px, not +100.
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 250)).toBeCloseTo(450, 9)
  })

  it('accumulates screen arc across a bend, not straight-line distance', () => {
    // 300 px east then 300 px north: the point at 200 m sits 600 px along the PATH
    // while being only ~424 px from the start as the crow flies.
    const px = new Float32Array([0, 300, 300])
    const py = new Float32Array([0, 0, -300])
    const pm = new Float64Array([0, 100, 200])
    expect(mercOffsetToScreenOffset(px, py, pm, 3, 200)).toBeCloseTo(600, 9)
  })

  it('is 0 for a run too short to interpolate', () => {
    const r = run([5], [10])
    expect(mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 999)).toBe(0)
  })

  it('does not divide by zero on a degenerate duplicate sample', () => {
    const r = run([0, 100, 200], [0, 0, 100])
    const v = mercOffsetToScreenOffset(r.px, r.py, r.pm, r.pn, 0)
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBe(0)
  })
})
