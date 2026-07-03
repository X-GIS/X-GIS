import { describe, it, expect } from 'vitest'
import { computeMiterPadRatio } from './line-segment-build'

// #432 item 4 — miter-limit bevel threshold uses the wrong half-angle trig.
// computeMiterPadRatio(tangentA=arriving, tangentB=leaving, miterLimit) returns
// 1 (bevel, no miter extension) when the corner is sharper than the limit,
// else the along-pad tan(θ/2) capped at the limit. The Mapbox miter ratio is
// 1/sin(interiorHalf) = 1/cos(θ/2) (θ = deflection = 180°−interior), so it must
// bevel when cos(θ/2) < 1/L. The buggy code tested sin(θ/2) < 1/L — failing to
// bevel SHARP corners and SPURIOUSLY bevelling SHALLOW ones.
//
// fail-before: with the sin(θ/2) test, the interior-45° case returns the capped
// miter (≈2 at L=2) instead of 1, and the interior-150° case returns 1 (spurious
// bevel) instead of the small miter pad.

/** Build (arriving, leaving) unit tangents for a join of the given INTERIOR
 *  angle (degrees). Deflection θ = 180 − interior; leaving = arriving rotated
 *  by θ. Arriving = +x. */
function tangents(interiorDeg: number): [[number, number], [number, number]] {
  const theta = ((180 - interiorDeg) * Math.PI) / 180
  return [
    [1, 0],
    [Math.cos(theta), Math.sin(theta)],
  ]
}

describe('computeMiterPadRatio — miter-limit bevel threshold (#432)', () => {
  it('sharp 45° interior bevels at limit 2 (ratio 2.61 > 2)', () => {
    const [a, b] = tangents(45)
    expect(computeMiterPadRatio(a, b, 2)).toBe(1) // bevel
  })

  it('sharp 45° interior miters at limit 4 (ratio 2.61 < 4)', () => {
    const [a, b] = tangents(45)
    // along-pad tan(67.5°) ≈ 2.414, under the cap → miter, NOT 1.
    expect(computeMiterPadRatio(a, b, 4)).toBeCloseTo(Math.tan((67.5 * Math.PI) / 180), 3)
  })

  it('shallow 150° interior does NOT bevel at limit 2 (ratio 1.04 < 2)', () => {
    const [a, b] = tangents(150)
    const r = computeMiterPadRatio(a, b, 2)
    expect(r).not.toBe(1) // must miter, not spuriously bevel
    expect(r).toBeCloseTo(Math.tan((15 * Math.PI) / 180), 3) // tan(θ/2), θ=30°
  })

  it('moderate 70° interior: bevels at a tight limit, miters at a loose one', () => {
    const [a, b] = tangents(70) // ratio 1/sin35° ≈ 1.743
    expect(computeMiterPadRatio(a, b, 1.5)).toBe(1) // 1.743 > 1.5 → bevel
    // 1.743 < 2 → miter; along-pad tan(55°) ≈ 1.428 (≠ 1, no sentinel collision).
    expect(computeMiterPadRatio(a, b, 2)).toBeCloseTo(Math.tan((55 * Math.PI) / 180), 3)
  })

  it('near-straight join needs no miter (collinear short-circuit)', () => {
    const [a, b] = tangents(179)
    expect(computeMiterPadRatio(a, b, 2)).toBe(1)
  })
})
