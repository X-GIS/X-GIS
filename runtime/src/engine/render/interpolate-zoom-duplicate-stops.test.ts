// Pin span-zero (duplicate-zoom-stop) guard in interpolateZoom +
// interpolateZoomRgba. Pre-fix `(zoom - z0) / 0` produced Infinity,
// multiplied into the lerp, yielded NaN or Infinity at the property
// value; the GPU sampler exhibited undefined-driver behaviour.
// Mirrors the compiler-evaluator duplicate-x guard.

import { describe, it, expect } from 'vitest'
import { interpolateZoom, interpolateZoomRgba } from './renderer'

describe('interpolateZoom duplicate-zoom stops', () => {
  it('linear: duplicate-zoom returns finite value (not NaN)', () => {
    const stops = [
      { zoom: 5, value: 10 },
      { zoom: 5, value: 20 },
      { zoom: 10, value: 100 },
    ]
    const result = interpolateZoom(stops, 5, 1)
    expect(Number.isFinite(result)).toBe(true)
  })

  it('linear: zoom exactly at the duplicate point returns finite', () => {
    const stops = [
      { zoom: 0, value: 0 },
      { zoom: 10, value: 50 },
      { zoom: 10, value: 100 },
    ]
    const result = interpolateZoom(stops, 10, 1)
    expect(Number.isFinite(result)).toBe(true)
  })

  it('rgba: duplicate-zoom returns finite RGBA (not NaN tuple)', () => {
    const stops = [
      { zoom: 5, value: [0.1, 0.2, 0.3, 1] as [number, number, number, number] },
      { zoom: 5, value: [0.4, 0.5, 0.6, 1] as [number, number, number, number] },
      { zoom: 10, value: [0.9, 0.8, 0.7, 1] as [number, number, number, number] },
    ]
    const result = interpolateZoomRgba(stops, 5)
    for (const channel of result) expect(Number.isFinite(channel)).toBe(true)
  })

  it('normal stops still interpolate correctly (regression guard)', () => {
    const stops = [
      { zoom: 0, value: 0 },
      { zoom: 10, value: 100 },
    ]
    expect(interpolateZoom(stops, 5, 1)).toBe(50)
  })
})
