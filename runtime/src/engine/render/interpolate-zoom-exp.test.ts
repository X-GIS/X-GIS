// Mapbox `["interpolate", ["exponential", N], ["zoom"], …]` runtime
// curve. `interpolateZoom(stops, zoom, base)` falls through to linear
// when base is omitted or 1, and walks the Mapbox exponential formula
// otherwise. Pins the curve so OFM Bright's 65 exponential line-width
// stops match MapLibre's visual.

import { describe, it, expect } from 'vitest'
import { interpolateZoom } from './renderer'

describe('interpolateZoom — linear (no base)', () => {
  const stops = [{ zoom: 0, value: 0 }, { zoom: 10, value: 100 }]

  it('endpoints clamp', () => {
    expect(interpolateZoom(stops, -1)).toBe(0)
    expect(interpolateZoom(stops, 11)).toBe(100)
  })
  it('midpoint is the arithmetic mean', () => {
    expect(interpolateZoom(stops, 5)).toBe(50)
  })
  it('quarter-point is the arithmetic quarter', () => {
    expect(interpolateZoom(stops, 2.5)).toBe(25)
  })
})

describe('interpolateZoom — exponential (base > 1)', () => {
  const stops = [{ zoom: 0, value: 0 }, { zoom: 10, value: 100 }]
  const base = 2

  it('endpoints still clamp', () => {
    expect(interpolateZoom(stops, -1, base)).toBe(0)
    expect(interpolateZoom(stops, 11, base)).toBe(100)
  })

  it('midpoint matches Mapbox formula', () => {
    // t = (2^5 - 1) / (2^10 - 1) = 31 / 1023
    const expected = 100 * (31 / 1023)
    expect(interpolateZoom(stops, 5, base)).toBeCloseTo(expected, 6)
  })

  it('curve is BELOW the linear midpoint (base > 1 accelerates near upper stop)', () => {
    // 100 * 31 / 1023 ≈ 3.03 — well below 50 (linear midpoint).
    const v = interpolateZoom(stops, 5, base)
    expect(v).toBeLessThan(50)
  })

  it('zoom near upper stop is close to upper value (steep slope)', () => {
    // At z=9 with base=2: t = (2^9 - 1)/(2^10 - 1) = 511/1023 ≈ 0.5
    const expected = 100 * (511 / 1023)
    expect(interpolateZoom(stops, 9, base)).toBeCloseTo(expected, 6)
  })

  it('base=1 collapses to linear (fast path)', () => {
    expect(interpolateZoom(stops, 5, 1)).toBe(50)
  })

  it('base ≈ 1 (within 1e-6) collapses to linear', () => {
    expect(interpolateZoom(stops, 5, 1 + 1e-7)).toBe(50)
  })
})

describe('interpolateZoom — exponential (0 < base < 1, decelerating)', () => {
  const stops = [{ zoom: 0, value: 0 }, { zoom: 10, value: 100 }]
  const base = 0.5

  it('midpoint above linear (curve accelerates near lower stop)', () => {
    // t = (0.5^5 - 1) / (0.5^10 - 1)
    const t = (Math.pow(0.5, 5) - 1) / (Math.pow(0.5, 10) - 1)
    const expected = 100 * t
    expect(interpolateZoom(stops, 5, base)).toBeCloseTo(expected, 6)
    expect(expected).toBeGreaterThan(50)
  })
})

describe('interpolateZoom — OFM Bright realistic road-width curve', () => {
  // Typical OFM Bright road width: base=1.3, 11→1, 19→2.5.
  const stops = [{ zoom: 11, value: 1 }, { zoom: 19, value: 2.5 }]
  const base = 1.3

  it('low-zoom edge is the start value', () => {
    expect(interpolateZoom(stops, 11, base)).toBeCloseTo(1, 6)
  })

  it('high-zoom edge is the end value', () => {
    expect(interpolateZoom(stops, 19, base)).toBeCloseTo(2.5, 6)
  })

  it('exponential stays BELOW linear in the lower half of the range', () => {
    // At z=15 (midpoint of 11..19):
    const exp15 = interpolateZoom(stops, 15, base)
    const lin15 = interpolateZoom(stops, 15) // default base=1 (linear)
    expect(exp15).toBeLessThan(lin15)
    // Specifically: 1 + 1.5 * (1.3^4 - 1) / (1.3^8 - 1)
    const t = (Math.pow(1.3, 4) - 1) / (Math.pow(1.3, 8) - 1)
    expect(exp15).toBeCloseTo(1 + 1.5 * t, 6)
  })
})
