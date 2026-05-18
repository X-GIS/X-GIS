// Pin zoomBase pass-through in resolveNumberShape for kind:'zoom-time'.
// Pre-iter-412 the runtime called interpolateZoom with base=1 in the
// zoom-time merge, so exponential paint curves silently collapsed to
// linear the moment a time animation joined the same axis.

import { describe, it, expect } from 'vitest'
import { resolveNumberShape } from './paint-shape-resolve'

describe('zoom-time PropertyShape honors zoomBase', () => {
  it('base !== 1 produces curve different from linear at the same zoom', () => {
    const stops = [{ zoom: 0, value: 0 }, { zoom: 10, value: 100 }]
    const timeStops = [{ timeMs: 0, value: 1 }] // identity time factor

    const linear = resolveNumberShape(
      { kind: 'zoom-time', zoomStops: stops, timeStops, loop: false, easing: 'linear', delayMs: 0 },
      5, 0,
    ).value
    const exp = resolveNumberShape(
      {
        kind: 'zoom-time',
        zoomStops: stops,
        zoomBase: 2,
        timeStops,
        loop: false,
        easing: 'linear',
        delayMs: 0,
      },
      5, 0,
    ).value

    expect(linear).toBeCloseTo(50, 6)            // linear z=5 → 50
    // Exponential base=2: t = (2^5 - 1) / (2^10 - 1) ≈ 31/1023 ≈ 0.0303
    // value = 0 + t * (100 - 0) ≈ 3.03
    expect(exp).toBeLessThan(linear)
    expect(exp).toBeCloseTo((Math.pow(2, 5) - 1) / (Math.pow(2, 10) - 1) * 100, 4)
  })

  it('zoomBase undefined falls back to linear (byte-identical)', () => {
    const stops = [{ zoom: 0, value: 0 }, { zoom: 10, value: 100 }]
    const timeStops = [{ timeMs: 0, value: 1 }]
    const result = resolveNumberShape(
      { kind: 'zoom-time', zoomStops: stops, timeStops, loop: false, easing: 'linear', delayMs: 0 },
      5, 0,
    ).value
    expect(result).toBeCloseTo(50, 6)
  })

  it('zoom factor multiplies by time factor as before', () => {
    // zoom at z=5 with linear 0..100 → 50; time at t=0 with [{0,1},{1000,0.5}] → 1.0
    const result = resolveNumberShape(
      {
        kind: 'zoom-time',
        zoomStops: [{ zoom: 0, value: 0 }, { zoom: 10, value: 100 }],
        timeStops: [{ timeMs: 0, value: 1 }, { timeMs: 1000, value: 0.5 }],
        loop: false, easing: 'linear', delayMs: 0,
      },
      5, 0,
    ).value
    expect(result).toBeCloseTo(50, 6) // 50 * 1.0
  })
})
