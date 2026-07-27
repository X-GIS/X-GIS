// ═══ interpolateVectorCoverage — forecast-hour vector-field blending (#1333) ═══
//
// Pins: t=0/t=1 boundary identity, the 360°/0° wraparound (the reason this interpolates
// vector COMPONENTS, not angle + magnitude independently), a mid-blend magnitude sanity check,
// nodata propagation (either side NaN ⇒ result NaN), a pass-through band left untouched, and
// the loud geometry-mismatch guard.

import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageInput } from './format'
import { interpolateVectorCoverage } from './interpolate-vector'

function handle(speed: number[], dir: number[], other?: number[]) {
  const input: CoverageInput = {
    product: 's111',
    origin: [10, 50],
    spacing: [1, 1],
    size: [speed.length, 1],
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      { name: 'surfaceCurrentSpeed', unit: 'knots', kind: 'f32', nodata: -9999, values: Float32Array.from(speed) },
      { name: 'surfaceCurrentDirection', unit: 'arc-degrees', kind: 'f32', nodata: -9999, values: Float32Array.from(dir) },
      ...(other
        ? [{ name: 'extra', unit: 'unitless', kind: 'f32' as const, nodata: -9999, values: Float32Array.from(other) }]
        : []),
    ],
  }
  return coverageFromGrids(input)
}

describe('interpolateVectorCoverage (#1333)', () => {
  it('t=0 reproduces `a` exactly; t=1 reproduces `b` exactly', () => {
    const a = handle([1, 2], [90, 180])
    const b = handle([3, 0.5], [200, 45])
    const at0 = interpolateVectorCoverage(a, b, 0)
    expect([...at0.band('surfaceCurrentSpeed').values]).toEqual([...a.band('surfaceCurrentSpeed').values])
    expect([...at0.band('surfaceCurrentDirection').values].map((d) => Math.round(d))).toEqual([90, 180])
    const at1 = interpolateVectorCoverage(a, b, 1)
    expect([...at1.band('surfaceCurrentSpeed').values].map((v) => Math.round(v * 10) / 10)).toEqual([3, 0.5])
    expect([...at1.band('surfaceCurrentDirection').values].map((d) => Math.round(d))).toEqual([200, 45])
  })

  it('interpolates a CONSTANT speed at a fixed bearing to the SAME speed/bearing at any t', () => {
    // Both hours agree exactly — a degenerate but load-bearing sanity check: blending identical
    // vectors must reproduce them, not drift from floating-point round-tripping through fx/fy.
    const a = handle([2], [45])
    const b = handle([2], [45])
    const mid = interpolateVectorCoverage(a, b, 0.5)
    expect(mid.band('surfaceCurrentSpeed').values[0]).toBeCloseTo(2, 5)
    expect(mid.band('surfaceCurrentDirection').values[0]).toBeCloseTo(45, 3)
  })

  it('crosses the 360°/0° wraparound the SHORT way (350°→10°), not through 180°', () => {
    const a = handle([1], [350])
    const b = handle([1], [10])
    const mid = interpolateVectorCoverage(a, b, 0.5)
    // The short way through 0/360 lands at 0° (or 360°); the wrong (long) way would land at 180°.
    const d = mid.band('surfaceCurrentDirection').values[0]!
    expect(d < 5 || d > 355).toBe(true)
    expect(d).not.toBeCloseTo(180, 0)
  })

  it('a CALM side (speed 0, direction undefined) still blends to a sane result', () => {
    // fx=fy=0 at the calm side regardless of its (meaningless) direction value — the vector
    // formulation degrades gracefully instead of needing special-case handling.
    const a = handle([0], [0]) // calm; direction is arbitrary/meaningless here
    const b = handle([4], [90]) // due east at 4 kn
    const quarter = interpolateVectorCoverage(a, b, 0.25)
    expect(quarter.band('surfaceCurrentSpeed').values[0]).toBeCloseTo(1, 5) // 25% of the way to 4
    expect(quarter.band('surfaceCurrentDirection').values[0]).toBeCloseTo(90, 3) // b's bearing (a contributes nothing)
  })

  it('a cell that is nodata (NaN) in EITHER source stays NaN in the result', () => {
    const a = handle([1, NaN], [90, 90])
    const b = handle([2, 5], [90, NaN])
    const mid = interpolateVectorCoverage(a, b, 0.5)
    expect(mid.band('surfaceCurrentSpeed').values[0]).toBeCloseTo(1.5, 5) // both valid → blends
    expect(Number.isNaN(mid.band('surfaceCurrentSpeed').values[1])).toBe(true) // a's speed was NaN
    expect(Number.isNaN(mid.band('surfaceCurrentDirection').values[1])).toBe(true) // b's dir was NaN
  })

  it('a band OTHER than speed/direction copies through from `a` unchanged', () => {
    const a = handle([1], [90], [7])
    const b = handle([2], [90], [99]) // different `extra` value — must be IGNORED
    const mid = interpolateVectorCoverage(a, b, 0.5)
    expect(mid.band('extra').values[0]).toBe(7)
  })

  it('preserves geometry (origin/spacing/size/product) from `a`', () => {
    const a = handle([1], [0])
    const b = handle([2], [0])
    const mid = interpolateVectorCoverage(a, b, 0.5)
    expect(mid.header.origin).toEqual(a.header.origin)
    expect(mid.header.spacing).toEqual(a.header.spacing)
    expect(mid.header.size).toEqual(a.header.size)
    expect(mid.header.product).toBe('s111')
  })

  it('throws LOUDLY on a grid-size mismatch — never silently blends mismatched geometry', () => {
    const a = handle([1, 2], [0, 0]) // 2×1
    const bInput: CoverageInput = {
      product: 's111',
      origin: [10, 50],
      spacing: [1, 1],
      size: [1, 1], // different size
      vertical: { datumCode: null, sign: 'up' },
      bands: [
        { name: 'surfaceCurrentSpeed', unit: 'knots', kind: 'f32', nodata: -9999, values: Float32Array.from([1]) },
        { name: 'surfaceCurrentDirection', unit: 'arc-degrees', kind: 'f32', nodata: -9999, values: Float32Array.from([0]) },
      ],
    }
    const b = coverageFromGrids(bInput)
    expect(() => interpolateVectorCoverage(a, b, 0.5)).toThrow(/size mismatch/)
  })
})
