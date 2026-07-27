import { describe, it, expect } from 'vitest'
import { packFlowFieldUV } from './flow-field-pack'
import { NODATA_CODE } from '@xgis/data'

// Flow-field (u,v) packing (#1333). The gates below pin the two decisions the design calls
// load-bearing — component storage (so a filtering sampler interpolates correctly across the
// 0/360 wrap) and nodata → (0,0) (so invalid regions do not advect) — plus the normalization
// contract the shader depends on to recover real velocity.

/** Decode an IEEE-754 half back to f32, so assertions read in real units rather than bits. */
function f16(bits: number): number {
  const s = bits & 0x8000 ? -1 : 1
  const e = (bits >> 10) & 0x1f
  const m = bits & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 0x1f) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

describe('packFlowFieldUV (#1333 flow-field texture encoding)', () => {
  it('decomposes speed + direction TRUE into east/north components', () => {
    // 0° = north, 90° = east — the S-100 convention the arrow portrayal already uses.
    const { u, v, scale } = packFlowFieldUV(
      Float32Array.from([2, 2, 2, 2]),
      Float32Array.from([0, 90, 180, 270]),
    )
    expect(scale).toBe(2)
    const east = [...u].map(f16).map((x) => x * scale)
    const north = [...v].map(f16).map((x) => x * scale)
    expect(east[0]!).toBeCloseTo(0, 2)
    expect(north[0]!).toBeCloseTo(2, 2) // due north
    expect(east[1]!).toBeCloseTo(2, 2) // due east
    expect(north[1]!).toBeCloseTo(0, 2)
    expect(north[2]!).toBeCloseTo(-2, 2) // due south
    expect(east[3]!).toBeCloseTo(-2, 2) // due west
  })

  it('THE WRAP GATE: components average correctly across 0/360, where degrees do not', () => {
    // A filtering sampler linearly blends stored texels. 350° and 10° are 20° apart; the
    // correct mean heading is 0° (north). Averaging the DEGREES gives 180° — due south, the
    // exact opposite. This is why the field is stored as components.
    const { u, v, scale } = packFlowFieldUV(Float32Array.from([1, 1]), Float32Array.from([350, 10]))
    const east = (f16(u[0]!) + f16(u[1]!)) / 2
    const north = (f16(v[0]!) + f16(v[1]!)) / 2
    const heading = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
    expect(heading).toBeCloseTo(0, 1) // north, NOT 180
    // And the naive alternative really would have been wrong — the test is not vacuous.
    expect((350 + 10) / 2).toBe(180)
    expect(scale).toBe(1)
  })

  it('nodata in EITHER band packs to (0,0) so invalid cells do not advect', () => {
    const { u, v } = packFlowFieldUV(
      Float32Array.from([3, NaN, 3, 3]),
      Float32Array.from([90, 90, NaN, 90]),
    )
    expect([f16(u[1]!), f16(v[1]!)]).toEqual([0, 0]) // speed missing
    expect([f16(u[2]!), f16(v[2]!)]).toEqual([0, 0]) // direction missing
    expect(f16(u[0]!)).toBeGreaterThan(0) // a valid neighbour still carries flow
    expect(f16(u[3]!)).toBeGreaterThan(0)
  })

  it('honours the u16 nodata CODE, not just a NaN round-trip', () => {
    const speedCodes = Uint16Array.from([100, NODATA_CODE, 100])
    const { u, v } = packFlowFieldUV(
      Float32Array.from([3, 3, 3]), // finite everywhere — only the code marks nodata
      Float32Array.from([90, 90, 90]),
      speedCodes,
    )
    expect([f16(u[1]!), f16(v[1]!)]).toEqual([0, 0])
    expect(f16(u[0]!)).toBeGreaterThan(0)
  })

  it('normalizes by the peak speed, and the peak comes only from VALID cells', () => {
    // The nodata cell carries a huge finite value; letting it set the scale would crush the
    // real field toward zero and make the whole flow layer imperceptible.
    const { u, scale } = packFlowFieldUV(
      Float32Array.from([1, 4, 999]),
      Float32Array.from([90, 90, 90]),
      Uint16Array.from([10, 10, NODATA_CODE]),
    )
    expect(scale).toBe(4)
    expect(f16(u[1]!)).toBeCloseTo(1, 2) // the peak normalizes to exactly 1
    expect(f16(u[0]!)).toBeCloseTo(0.25, 2)
  })

  it('stays inside [-1,1] so the f16 error is bounded by the field, not by absolute units', () => {
    const speed = Float32Array.from({ length: 64 }, (_, i) => (i % 13) * 0.9)
    const dir = Float32Array.from({ length: 64 }, (_, i) => (i * 37) % 360)
    const { u, v } = packFlowFieldUV(speed, dir)
    for (let i = 0; i < 64; i++) {
      expect(Math.abs(f16(u[i]!))).toBeLessThanOrEqual(1 + 1e-3)
      expect(Math.abs(f16(v[i]!))).toBeLessThanOrEqual(1 + 1e-3)
    }
  })

  it('a calm or all-nodata field packs to zeros with scale 0 (no motion, no NaN texel)', () => {
    const calm = packFlowFieldUV(
      new Float32Array(9),
      Float32Array.from({ length: 9 }, () => 45),
    )
    expect(calm.scale).toBe(0)
    expect([...calm.u].every((x) => x === 0)).toBe(true)
    expect([...calm.v].every((x) => x === 0)).toBe(true)

    const none = packFlowFieldUV(
      Float32Array.from({ length: 4 }, () => NaN),
      Float32Array.from({ length: 4 }, () => NaN),
    )
    expect(none.scale).toBe(0)
    // Critically: zeros, never a NaN texel — a NaN would poison every filtered neighbour.
    expect([...none.u].some(Number.isNaN)).toBe(false)
  })

  it('rejects a band-length mismatch loudly rather than packing a truncated field', () => {
    expect(() => packFlowFieldUV(new Float32Array(4), new Float32Array(3))).toThrow(
      /length mismatch/,
    )
  })
})
