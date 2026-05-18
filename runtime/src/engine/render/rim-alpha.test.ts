// CPU mirror of the WGSL rim_alpha() function. Validates the
// smoothstep math at the visibility boundary so fragment shaders
// can multiply this into output alpha and replace the previous
// hard-discard for sphere-rim geometry.
//
// The WGSL implementation lives in runtime/src/engine/shaders/
// projection.ts. This test pins the math behaviour (boundary 0,
// inside 1, fade in between) without spinning up a real WebGPU
// device; integration with renderer fragment paths is the
// follow-up.

import { describe, expect, it } from 'vitest'

const RIM_FADE = 0.02

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// Mirror of WGSL rim_alpha for testing.
function rimAlpha(projType: number, cosC: number): number {
  if (projType <= 2) return 1.0          // flat / cylindrical — no rim
  if (projType === 3) return smoothstep(0.0, RIM_FADE, cosC)       // ortho
  if (projType === 4) return smoothstep(-0.85, -0.85 + RIM_FADE, cosC) // azimuth
  if (projType === 5) return smoothstep(-0.8, -0.8 + RIM_FADE, cosC)   // stereo
  if (projType === 6) return 1.0          // oblique — no rim
  return smoothstep(0.0, RIM_FADE, cosC) // globe
}

describe('rim_alpha (CPU mirror of WGSL)', () => {
  describe('ortho (projType 3)', () => {
    it('is 0 strictly behind the hemisphere', () => {
      expect(rimAlpha(3, -0.5)).toBe(0)
      expect(rimAlpha(3, -0.01)).toBe(0)
    })
    it('is 1 strictly in front', () => {
      expect(rimAlpha(3, 0.5)).toBe(1)
      expect(rimAlpha(3, 0.1)).toBe(1)
    })
    it('fades smoothly across [0, RIM_FADE]', () => {
      const mid = rimAlpha(3, RIM_FADE / 2)
      expect(mid).toBeGreaterThan(0)
      expect(mid).toBeLessThan(1)
      expect(mid).toBeCloseTo(0.5, 1)
    })
  })

  describe('azimuthal equidistant (projType 4)', () => {
    it('is 0 well past the -0.85 threshold', () => {
      expect(rimAlpha(4, -0.9)).toBe(0)
    })
    it('is 1 well in front of threshold', () => {
      expect(rimAlpha(4, 0.5)).toBe(1)
    })
    it('fades around -0.85', () => {
      const mid = rimAlpha(4, -0.85 + RIM_FADE / 2)
      expect(mid).toBeCloseTo(0.5, 1)
    })
  })

  describe('stereographic (projType 5)', () => {
    it('threshold at -0.8', () => {
      expect(rimAlpha(5, -0.9)).toBe(0)
      expect(rimAlpha(5, -0.7)).toBe(1)
      expect(rimAlpha(5, -0.8 + RIM_FADE / 2)).toBeCloseTo(0.5, 1)
    })
  })

  describe('globe (projType 7)', () => {
    it('matches ortho rim behaviour', () => {
      expect(rimAlpha(7, -0.5)).toBe(0)
      expect(rimAlpha(7, 0.5)).toBe(1)
      expect(rimAlpha(7, RIM_FADE / 2)).toBeCloseTo(0.5, 1)
    })
  })

  describe('flat / cylindrical / oblique', () => {
    it('always 1.0 (no rim concept)', () => {
      for (const t of [0, 1, 2, 6]) {
        expect(rimAlpha(t, -1)).toBe(1)
        expect(rimAlpha(t, 0)).toBe(1)
        expect(rimAlpha(t, 1)).toBe(1)
      }
    })
  })

  it('rim_alpha is monotone non-decreasing in cos_c on globe', () => {
    let prev = -1
    for (let cc = -1; cc <= 1; cc += 0.05) {
      const a = rimAlpha(7, cc)
      expect(a).toBeGreaterThanOrEqual(prev)
      prev = a
    }
  })
})
