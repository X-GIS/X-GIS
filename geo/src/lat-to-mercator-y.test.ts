import { describe, it, expect } from 'vitest'
import { latToMercatorY, mercator, MERCATOR_LAT_LIMIT } from '@xgis/geo'
import { EARTH } from '@xgis/shared'

// Pins the single-authority contract behind #1828's packer cleanup: the five graphics
// retained-*-packers used to hand-inline `clamp ± MERCATOR_LAT_LIMIT` +
// `Math.log(Math.tan(Math.PI / 4 + (latC * DEG2RAD) / 2)) * EARTH.sphereR` and now call
// latToMercatorY instead. The routing is admissible ONLY because it changes no double —
// same constants, same operation order — so this test compares BIT equality (toBe, not
// toBeCloseTo) against the exact former spelling, across the range and beyond the clamp.

const DEG2RAD = Math.PI / 180
/** The packers' former inline spelling, verbatim. */
const inlineFormer = (lat: number): number => {
  const latC = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat))
  return Math.log(Math.tan(Math.PI / 4 + (latC * DEG2RAD) / 2)) * EARTH.sphereR
}

describe('latToMercatorY — the Y-only forward authority (#1828)', () => {
  const SWEEP = [
    0, 1e-9, -1e-9, 0.5, -0.5, 1, 12.3456789, -33.3, 45, -60.000001, 80, -85, 85.051129, -85.051129,
    85.5, -85.5, 90, -90, 123, -123,
  ]

  it('is DOUBLE-IDENTICAL to the packers` former inline spelling, clamp included', () => {
    for (const lat of SWEEP) expect(latToMercatorY(lat)).toBe(inlineFormer(lat))
  })

  it('is exactly mercator.forward`s y (the projection authority routes through it)', () => {
    for (const lat of SWEEP) expect(mercator.forward(0, lat)[1]).toBe(latToMercatorY(lat))
  })

  it('clamps beyond ±MERCATOR_LAT_LIMIT instead of diverging', () => {
    expect(latToMercatorY(90)).toBe(latToMercatorY(MERCATOR_LAT_LIMIT))
    expect(latToMercatorY(-90)).toBe(latToMercatorY(-MERCATOR_LAT_LIMIT))
    expect(Number.isFinite(latToMercatorY(90))).toBe(true)
  })
})
