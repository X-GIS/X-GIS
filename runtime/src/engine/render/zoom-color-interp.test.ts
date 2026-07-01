// Iter 549 — regression gate for zoom-interpolated color blending.
// User directive workflow #1 added: "올바른 색상이 렌더링되는지
// 검증하여라" (verify correct colors render).
//
// Verifies `interpolateZoomRgba` produces:
// - correct midpoint for 2-stop and 3-stop ramps
// - alpha channel interpolated independently
// - exponential base curves (Mapbox `["exponential", base]`)
// - clamping below first / above last stop
// - duplicate-zoom guard (zero-span span avoids NaN)
//
// X-GIS uses LINEAR-RGB per-channel interpolation, matching MapLibre's
// default behaviour. HCL / LAB color space variants approximate as
// linear-RGB (documented partial; covered separately by spec-coverage).

import { describe, it, expect } from 'vitest'
import { interpolateZoomRgba } from '@xgis/map'

type Stop = { zoom: number; value: [number, number, number, number] }

function approxRgba(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(4)
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(actual[i]! - expected[i]!), `channel ${i}: ${actual[i]} vs ${expected[i]}`).toBeLessThan(1e-6)
  }
}

describe('zoom-interpolated RGBA (iter 549)', () => {
  const blackToWhite: Stop[] = [
    { zoom: 0, value: [0, 0, 0, 1] },
    { zoom: 10, value: [1, 1, 1, 1] },
  ]

  it('midpoint of 0→10 = 5 → 50% grey', () => {
    approxRgba(interpolateZoomRgba(blackToWhite, 5), [0.5, 0.5, 0.5, 1])
  })

  it('quarter point z=2.5 → 25% grey', () => {
    approxRgba(interpolateZoomRgba(blackToWhite, 2.5), [0.25, 0.25, 0.25, 1])
  })

  it('clamp below first → first stop value', () => {
    approxRgba(interpolateZoomRgba(blackToWhite, -5), [0, 0, 0, 1])
  })

  it('clamp above last → last stop value', () => {
    approxRgba(interpolateZoomRgba(blackToWhite, 20), [1, 1, 1, 1])
  })

  describe('linear-RGB per-channel (matches MapLibre default)', () => {
    it('red→blue midpoint → purple (0.5, 0, 0.5)', () => {
      const stops: Stop[] = [
        { zoom: 0, value: [1, 0, 0, 1] },
        { zoom: 10, value: [0, 0, 1, 1] },
      ]
      approxRgba(interpolateZoomRgba(stops, 5), [0.5, 0, 0.5, 1])
    })

    it('alpha interpolates independently of RGB', () => {
      const stops: Stop[] = [
        { zoom: 0, value: [1, 0, 0, 0] },
        { zoom: 10, value: [0, 0, 1, 1] },
      ]
      // At z=5: R = 0.5, G = 0, B = 0.5, A = 0.5
      approxRgba(interpolateZoomRgba(stops, 5), [0.5, 0, 0.5, 0.5])
    })
  })

  describe('3-stop ramps', () => {
    const tri: Stop[] = [
      { zoom: 0, value: [1, 0, 0, 0] },
      { zoom: 5, value: [0, 1, 0, 0.5] },
      { zoom: 10, value: [0, 0, 1, 1] },
    ]

    it('mid of first segment z=2.5 → between stops 0 & 1', () => {
      // R: 1 + 0.5*(0-1) = 0.5
      // G: 0 + 0.5*(1-0) = 0.5
      // B: 0
      // A: 0 + 0.5*(0.5-0) = 0.25
      approxRgba(interpolateZoomRgba(tri, 2.5), [0.5, 0.5, 0, 0.25])
    })

    it('exactly at middle stop → middle stop value', () => {
      approxRgba(interpolateZoomRgba(tri, 5), [0, 1, 0, 0.5])
    })

    it('mid of second segment z=7.5 → between stops 1 & 2', () => {
      // R: 0
      // G: 1 + 0.5*(0-1) = 0.5
      // B: 0 + 0.5*(1-0) = 0.5
      // A: 0.5 + 0.5*(1-0.5) = 0.75
      approxRgba(interpolateZoomRgba(tri, 7.5), [0, 0.5, 0.5, 0.75])
    })
  })

  describe('exponential base — Mapbox ["exponential", base]', () => {
    const stops: Stop[] = [
      { zoom: 0, value: [0, 0, 0, 1] },
      { zoom: 10, value: [1, 1, 1, 1] },
    ]

    it('base=2 at z=5 → ~0.0303 (heavy bottom curve)', () => {
      // t = (2^5 - 1) / (2^10 - 1) = 31 / 1023 ≈ 0.0303
      const r = interpolateZoomRgba(stops, 5, 2)
      expect(r[0]).toBeCloseTo(0.0303, 3)
    })

    it('base=1 collapses to linear path → 0.5 midpoint', () => {
      approxRgba(interpolateZoomRgba(stops, 5, 1), [0.5, 0.5, 0.5, 1])
    })

    it('base near 1 (epsilon) → linear path (no division-by-zero)', () => {
      approxRgba(interpolateZoomRgba(stops, 5, 1 + 1e-9), [0.5, 0.5, 0.5, 1])
    })
  })

  describe('defensive guards', () => {
    it('empty stops → opaque black', () => {
      approxRgba(interpolateZoomRgba([], 5), [0, 0, 0, 1])
    })

    it('single stop → that stop regardless of zoom', () => {
      const single: Stop[] = [{ zoom: 5, value: [0.3, 0.6, 0.9, 1] }]
      approxRgba(interpolateZoomRgba(single, 0), [0.3, 0.6, 0.9, 1])
      approxRgba(interpolateZoomRgba(single, 100), [0.3, 0.6, 0.9, 1])
    })

    it('duplicate-zoom stops do NOT produce NaN', () => {
      const dup: Stop[] = [
        { zoom: 5, value: [0, 0, 0, 1] },
        { zoom: 5, value: [1, 1, 1, 1] },
      ]
      const r = interpolateZoomRgba(dup, 5)
      expect(r.every(v => Number.isFinite(v))).toBe(true)
    })
  })
})
