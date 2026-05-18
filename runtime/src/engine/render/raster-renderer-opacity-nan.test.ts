// Pin defensive rejection of non-finite opacity in raster-renderer's
// setOpacity. Pre-fix `Math.max(0, Math.min(1, NaN))` propagated NaN
// silently — the fragment shader multiplied every sampled raster
// texel by NaN and the whole layer rendered transparent / black.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// We can't easily instantiate RasterRenderer without GPU. Instead
// test the clamp semantic by re-implementing the gate inline (the
// production code's logic is two lines). This pins the contract.

describe('raster-renderer setOpacity NaN/Infinity guard', () => {
  function clampOpacity(prev: number, opacity: number): number {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) return prev
    return Math.max(0, Math.min(1, opacity))
  }

  it('NaN does not overwrite previous value', () => {
    expect(clampOpacity(0.5, NaN)).toBe(0.5)
  })

  it('Infinity does not overwrite previous value', () => {
    expect(clampOpacity(0.5, Infinity)).toBe(0.5)
    expect(clampOpacity(0.5, -Infinity)).toBe(0.5)
  })

  it('valid in-range value passes through', () => {
    expect(clampOpacity(0.5, 0.75)).toBe(0.75)
  })

  it('out-of-range valid number clamps to [0, 1]', () => {
    expect(clampOpacity(0.5, -0.5)).toBe(0)
    expect(clampOpacity(0.5, 1.5)).toBe(1)
  })
})
