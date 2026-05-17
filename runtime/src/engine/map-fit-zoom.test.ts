import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'

// CPU regression: lonSpan === 0 (single-point or co-linear data such as
// fixture-point.geojson) made the inline `Math.log2(360 / (degPerPx *
// 256))` collapse to Infinity → camera.zoom = Infinity → projection
// matrix NaN → blank canvas with `#Infinity/0/0` badge. The helper
// `_fitZoomToLonSpan` was extracted so the five bounds-fit sites in
// map.ts share one degenerate-guard. This spec pins the helper's
// contract directly — no GPU, no e2e, just CPU math.

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

interface FitInternals {
  _fitZoomToLonSpan(lonSpan: number, cssWidthPx: number): number
}

describe('XGISMap._fitZoomToLonSpan', () => {
  const map = new XGISMap(mockCanvas()) as unknown as FitInternals

  it('returns a sensible default for a single-point bounds (lonSpan === 0)', () => {
    const z = map._fitZoomToLonSpan(0, 1024)
    expect(Number.isFinite(z)).toBe(true)
    expect(z).toBeGreaterThan(0)
    expect(z).toBeLessThan(20)
  })

  it('returns a finite default when cssWidthPx is 0 (degenerate canvas)', () => {
    const z = map._fitZoomToLonSpan(10, 0)
    expect(Number.isFinite(z)).toBe(true)
  })

  it('returns a finite default for negative lonSpan (caller bug guard)', () => {
    const z = map._fitZoomToLonSpan(-1, 1024)
    expect(Number.isFinite(z)).toBe(true)
  })

  it('produces a low zoom for a world-spanning bounds (≈360°)', () => {
    const z = map._fitZoomToLonSpan(360, 1024)
    expect(Number.isFinite(z)).toBe(true)
    // 360° fits a 1024 px viewport at roughly tile-0 scale (~z=1.0).
    expect(z).toBeGreaterThanOrEqual(0.5)
    expect(z).toBeLessThan(3)
  })

  it('produces a high zoom for a sub-degree bounds (city-block)', () => {
    const z = map._fitZoomToLonSpan(0.01, 1024)
    expect(Number.isFinite(z)).toBe(true)
    // 0.01° (~1 km at the equator) into a 1024 px viewport → z ~= 15.
    expect(z).toBeGreaterThan(10)
    expect(z).toBeLessThan(20)
  })

  it('is monotonic-decreasing in lonSpan (wider bounds → lower zoom)', () => {
    const a = map._fitZoomToLonSpan(1, 1024)
    const b = map._fitZoomToLonSpan(10, 1024)
    const c = map._fitZoomToLonSpan(100, 1024)
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })
})
