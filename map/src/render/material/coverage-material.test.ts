// ═══ coverage-material CPU helpers (#1158 GAP-1 INC-A / A3) ═══
//
// Verifies the render arm's pure CPU math WITHOUT a GPU (gate 3 — the headed
// readback — cannot run here): the f32→f16 converter against known bit patterns,
// the validity-weighted texture packing (value = f16(s·valid), valid = f16(valid),
// with u16 s = code/65534 EXACTLY), the ramp uniforms, and the A3 error budget
// (max|f16(s)−s| ≤ 2⁻¹²).

import { describe, it, expect } from 'vitest'
import {
  f32ToF16,
  packCoverageValueValid,
  computeRampUniforms,
  bakeRampLut,
} from './coverage-material'

// decode an f16 bit pattern back to f32 (test-only, for the error budget)
function f16ToF32(h: number): number {
  const s = (h & 0x8000) >> 15
  const e = (h & 0x7c00) >> 10
  const m = h & 0x03ff
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024)
  if (e === 0x1f) return m ? NaN : (s ? -1 : 1) * Infinity
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024)
}

describe('f32ToF16 (A3 — known bit-pattern vectors)', () => {
  it('matches the canonical half-float encodings', () => {
    expect(f32ToF16(0)).toBe(0x0000)
    expect(f32ToF16(1)).toBe(0x3c00)
    expect(f32ToF16(0.5)).toBe(0x3800)
    expect(f32ToF16(0.25)).toBe(0x3400)
    expect(f32ToF16(2)).toBe(0x4000)
    expect(f32ToF16(-1)).toBe(0xbc00)
    // round-trip stays within one f16 ULP
    for (const v of [0.1, 0.333, 0.7, 0.999, 0.001])
      expect(Math.abs(f16ToF32(f32ToF16(v)) - v)).toBeLessThan(Math.pow(2, -10))
  })
})

describe('packCoverageValueValid (A3 — validity-weighted packing)', () => {
  it('f32 band: value = f16(s), valid = f16(1); nodata ⇒ value 0, valid 0', () => {
    // values [10,20,30,NaN], range [10,30] → s = [0, 0.5, 1, nodata]
    const values = new Float32Array([10, 20, 30, NaN])
    const { value, valid } = packCoverageValueValid(values, 10, 30)
    expect(Array.from(value)).toEqual([f32ToF16(0), f32ToF16(0.5), f32ToF16(1), 0])
    expect(Array.from(valid)).toEqual([f32ToF16(1), f32ToF16(1), f32ToF16(1), 0])
  })

  it('u16 band: s = code/65534 EXACTLY (never via the dequantized f32)', () => {
    // codes [0, 32767, 65534, 0xFFFF] → s = [0, 0.5, 1, nodata]; the f32 `values`
    // are decoded (with rounding) but MUST NOT be used for s — codes are exact.
    const codes = new Uint16Array([0, 32767, 65534, 0xffff])
    const values = new Float32Array([10, 20.0001, 30, NaN]) // deliberately noisy
    const { value, valid } = packCoverageValueValid(values, 10, 30, codes)
    expect(value[0]).toBe(f32ToF16(0))
    expect(value[1]).toBe(f32ToF16(32767 / 65534)) // exactly 0.5-ish from the CODE
    expect(value[2]).toBe(f32ToF16(1))
    expect(value[3]).toBe(0) // nodata code
    expect(valid[3]).toBe(0)
  })

  it('a single nodata cell in a 4-cell grid packs a transparent (valid 0) texel', () => {
    const { value, valid } = packCoverageValueValid(new Float32Array([1, 2, NaN, 4]), 1, 4)
    expect(valid[2]).toBe(0)
    expect(value[2]).toBe(0)
    expect(valid[0]).toBe(f32ToF16(1))
  })
})

describe('A3 error budget (executable) — max|f16(s)−s| ≤ 2⁻¹²', () => {
  it('the normalized-storage f16 error is provably sub-bin over [0,1]', () => {
    let maxErr = 0
    for (let k = 0; k <= 4096; k++) {
      const s = k / 4096
      const err = Math.abs(f16ToF32(f32ToF16(s)) - s)
      if (err > maxErr) maxErr = err
    }
    // f16 round-to-nearest over [0,1]: worst octave [0.5,1) has ULP 2⁻¹¹ → err ≤ 2⁻¹²
    expect(maxErr).toBeLessThanOrEqual(Math.pow(2, -12) + 1e-9)
  })
})

describe('computeRampUniforms + bakeRampLut', () => {
  it('default range = data range → a=1, b=0 (identity)', () => {
    expect(computeRampUniforms(10, 30, 10, 30)).toEqual({ a: 1, b: 0 })
  })
  it('custom range maps a·s+b correctly', () => {
    // data [0,40], display range [0,40] → a=1,b=0; range [10,30] → a=2, b=-0.5
    // (maps v=rangeLo=10 → t=0 and v=rangeHi=30 → t=1: t = a·(v−dataMin)/(dataMax−dataMin) + b).
    expect(computeRampUniforms(0, 40, 0, 40)).toEqual({ a: 1, b: 0 })
    const u = computeRampUniforms(0, 40, 10, 30)
    expect(u.a).toBeCloseTo(2, 9)
    expect(u.b).toBeCloseTo(-0.5, 9)
    // sanity: v=10 → t=0, v=30 → t=1
    const t = (v: number) => u.a * ((v - 0) / (40 - 0)) + u.b
    expect(t(10)).toBeCloseTo(0, 9)
    expect(t(30)).toBeCloseTo(1, 9)
  })
  it('bakeRampLut yields a 256×4 rgba8 buffer for a named ramp', () => {
    const lut = bakeRampLut('bathymetry')
    expect(lut.length).toBe(256 * 4)
    expect(lut[3]).toBe(255) // opaque
    // endpoints match the palette's first/last stop (shallow → deep)
    expect([lut[0], lut[1], lut[2]]).toEqual([224, 243, 248])
    expect([lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]]).toEqual([49, 54, 149])
  })
  it('an unknown ramp name throws loudly (no silent palette substitution)', () => {
    // navigation data: a typo'd `ramp: "virdis"` must NOT silently render as bathymetry.
    expect(() => bakeRampLut('no-such-ramp')).toThrow(/unknown ramp "no-such-ramp"/)
    expect(bakeRampLut('bathymetry').length).toBe(256 * 4) // a known ramp still bakes
  })
})
