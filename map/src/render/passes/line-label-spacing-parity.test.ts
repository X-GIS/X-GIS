// `symbol-spacing` parity with MapLibre GL JS for symbol-placement: line.
//
// X-GIS walks the projected polyline in SCREEN space and used to step by a flat
// `symbol-spacing × dpr`, so a shield chain rendered denser than the reference at
// every non-integer zoom (user report on OFM Positron: 4 "400" shields where
// MapLibre draws 3, at #16.7/37.79172/126.79102).
//
// MapLibre lays symbols out in TILE units inside a bucket built for the covering
// integer zoom, then scales that bucket, so the step a viewer measures is
// `symbol-spacing × 2^frac(zoom)`. The expectations below are the MEASURED
// MapLibre cadence from a zoom sweep on OFM Positron `highway-shield-non-us`
// (symbol-spacing 200, 1800×900, dpr 1), taken by detecting the shield boxes in
// the reference pane and taking the median gap along the chain.

import { describe, it, expect } from 'vitest'
import { lineLabelSpacingPx } from './place-labels-along-line'

/** Median on-screen gap (CSS px) between consecutive "400" shields in the
 *  MapLibre pane, per zoom. See `playground/e2e/_debug-shield-spacing.spec.ts`. */
const MEASURED_MAPLIBRE: [zoom: number, gapPx: number][] = [
  [16.0, 199.9],
  [16.2, 229.3],
  [16.5, 282.7],
  [16.7, 325.1],
  [16.9, 373.5],
]

describe('line-label symbol-spacing — MapLibre cadence', () => {
  it('reproduces the measured MapLibre gap within 1 % at every sampled zoom', () => {
    for (const [zoom, measured] of MEASURED_MAPLIBRE) {
      const ours = lineLabelSpacingPx(200, 1, zoom)
      expect(Math.abs(ours - measured) / measured, `z${zoom}`).toBeLessThan(0.01)
    }
  })

  it('is a flat symbol-spacing at integer zooms and ~2× just below the next one', () => {
    expect(lineLabelSpacingPx(200, 1, 12)).toBeCloseTo(200, 6)
    expect(lineLabelSpacingPx(200, 1, 13)).toBeCloseTo(200, 6)
    expect(lineLabelSpacingPx(200, 1, 12.999999)).toBeGreaterThan(399)
    expect(lineLabelSpacingPx(200, 1, 12.999999)).toBeLessThan(400)
  })

  it('the flat pre-parity step was the bug: 200 px at z16.7 against MapLibre 325', () => {
    // Guards the regression direction, not just the formula — a revert to
    // `spacing × dpr` reads 200 here and fails.
    expect(lineLabelSpacingPx(200, 1, 16.7)).toBeGreaterThan(300)
  })

  it('scales with dpr on top of the zoom factor', () => {
    expect(lineLabelSpacingPx(200, 2, 16.0)).toBeCloseTo(400, 6)
    expect(lineLabelSpacingPx(200, 2, 16.5)).toBeCloseTo(400 * Math.SQRT2, 6)
  })

  it('a non-positive spacing stays 0 — the caller reads that as line-center', () => {
    expect(lineLabelSpacingPx(0, 3, 16.7)).toBe(0)
    expect(lineLabelSpacingPx(-5, 3, 16.7)).toBe(0)
    expect(lineLabelSpacingPx(Number.NaN, 3, 16.7)).toBe(0)
  })

  it('a non-finite zoom falls back to the unscaled step, never NaN', () => {
    // NaN would compare false against every stop and silently collapse the whole
    // chain to one midpoint label.
    expect(lineLabelSpacingPx(200, 2, Number.NaN)).toBe(400)
    expect(lineLabelSpacingPx(200, 2, Number.POSITIVE_INFINITY)).toBe(400)
  })
})
