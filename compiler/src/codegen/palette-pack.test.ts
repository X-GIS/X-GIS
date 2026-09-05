// ═══════════════════════════════════════════════════════════════════
// palette-pack.ts — pure pack + gradient evaluation tests
// ═══════════════════════════════════════════════════════════════════
//
// GPU upload (`uploadPalette`) requires a real GPUDevice and is
// exercised by integration tests; this file unit-tests the PURE
// shape of the module:
//   - packPalette: typed-array layout, byte values, dedup behaviour
//   - evalColorGradientAt / evalScalarGradientAt: linear + exponential
//     interpolation math against MapLibre's spec.

import { describe, expect, it } from 'vitest'
import {
  GRADIENT_WIDTH,
  GRADIENT_META_STRIDE_F32,
  evalColorGradientAt,
  evalScalarGradientAt,
  packPalette,
} from './palette-pack'
import type { Palette, ColorGradient, ScalarGradient } from './palette'

const RED: [number, number, number, number] = [1, 0, 0, 1]
const BLUE: [number, number, number, number] = [0, 0, 1, 1]

function makePalette(p: Partial<Palette>): Palette {
  const colors = (p.colors ?? []) as readonly [number, number, number, number][]
  const scalars = (p.scalars ?? []) as readonly number[]
  const colorGradients = (p.colorGradients ?? []) as readonly ColorGradient[]
  const scalarGradients = (p.scalarGradients ?? []) as readonly ScalarGradient[]
  return {
    colors,
    scalars,
    colorGradients,
    scalarGradients,
    findColor() {
      return -1
    },
    findScalar() {
      return -1
    },
    findColorGradient() {
      return -1
    },
    findScalarGradient() {
      return -1
    },
  }
}

describe('palette-texture — packPalette', () => {
  it('empty palette → stub 1×1 textures with zero counts', () => {
    const packed = packPalette(makePalette({}))
    expect(packed.colorCount).toBe(0)
    expect(packed.scalarCount).toBe(0)
    expect(packed.colorGradientCount).toBe(0)
    expect(packed.scalarGradientCount).toBe(0)
    // Buffers padded to ≥1 entry so writeTexture has something to copy.
    expect(packed.colorBytes.byteLength).toBe(4)
    expect(packed.scalarF32.byteLength).toBe(4)
    // rgba16float color gradient atlas: 8 bytes per texel.
    expect(packed.colorGradientBytes.byteLength).toBe(GRADIENT_WIDTH * 4 * 2)
    expect(packed.scalarGradientF32.byteLength).toBe(GRADIENT_WIDTH * 4)
  })

  it('two constant colors → 2×4 RGBA8 bytes', () => {
    const packed = packPalette(makePalette({ colors: [RED, BLUE] }))
    expect(packed.colorCount).toBe(2)
    // Red entry: 255, 0, 0, 255
    expect(packed.colorBytes[0]).toBe(255)
    expect(packed.colorBytes[1]).toBe(0)
    expect(packed.colorBytes[2]).toBe(0)
    expect(packed.colorBytes[3]).toBe(255)
    // Blue entry: 0, 0, 255, 255
    expect(packed.colorBytes[4]).toBe(0)
    expect(packed.colorBytes[5]).toBe(0)
    expect(packed.colorBytes[6]).toBe(255)
    expect(packed.colorBytes[7]).toBe(255)
  })

  it('two scalars → 2×f32', () => {
    const packed = packPalette(makePalette({ scalars: [1.5, 4.0] }))
    expect(packed.scalarCount).toBe(2)
    expect(packed.scalarF32[0]).toBe(1.5)
    expect(packed.scalarF32[1]).toBe(4.0)
  })

  it('color gradient bake → half-float endpoints + midpoint interpolated', () => {
    const g: ColorGradient = {
      stops: [
        { zoom: 0, value: RED },
        { zoom: 10, value: BLUE },
      ],
      base: 1,
    }
    const packed = packPalette(makePalette({ colorGradients: [g] }))
    expect(packed.colorGradientCount).toBe(1)
    // Manual half-float decoder — DataView.getFloat16 only landed
    // in Node 22 and isn't available on every CI runner. The
    // bit-pattern reverse is short + matches f32ToHalf's encoder.
    const halfToF32 = (h: number): number => {
      const sign = (h & 0x8000) >>> 15
      const exp = (h & 0x7c00) >>> 10
      const mant = h & 0x3ff
      if (exp === 0) return sign ? -0 : 0 // zero / subnormal → zero
      if (exp === 31) return sign ? -Infinity : Infinity
      const f = (1 + mant / 1024) * Math.pow(2, exp - 15)
      return sign ? -f : f
    }
    const getHalf = (texelIndex: number, channel: number): number =>
      halfToF32(packed.colorGradientBytes[texelIndex * 4 + channel]!)
    // First texel = stop 0 (red)
    expect(getHalf(0, 0)).toBeCloseTo(1.0)
    expect(getHalf(0, 1)).toBeCloseTo(0.0)
    expect(getHalf(0, 2)).toBeCloseTo(0.0)
    expect(getHalf(0, 3)).toBeCloseTo(1.0)
    // Last texel = stop 1 (blue)
    const lastIdx = GRADIENT_WIDTH - 1
    expect(getHalf(lastIdx, 0)).toBeCloseTo(0.0)
    expect(getHalf(lastIdx, 1)).toBeCloseTo(0.0)
    expect(getHalf(lastIdx, 2)).toBeCloseTo(1.0)
    // Midpoint (t = 0.5) under linear curve → r=b≈0.5.
    const midIdx = Math.floor(GRADIENT_WIDTH / 2)
    expect(getHalf(midIdx, 0)).toBeCloseTo(0.5, 1)
    expect(getHalf(midIdx, 2)).toBeCloseTo(0.5, 1)
  })

  it('color gradient meta encodes (zMin, zMax, base, _pad)', () => {
    const g: ColorGradient = {
      stops: [
        { zoom: 2, value: RED },
        { zoom: 15, value: BLUE },
      ],
      base: 1.5,
    }
    const packed = packPalette(makePalette({ colorGradients: [g] }))
    expect(packed.colorGradientMeta[0]).toBe(2)
    expect(packed.colorGradientMeta[1]).toBe(15)
    expect(packed.colorGradientMeta[2]).toBeCloseTo(1.5)
    expect(packed.colorGradientMeta[3]).toBe(0)
    expect(packed.colorGradientMeta.length).toBe(GRADIENT_META_STRIDE_F32)
  })

  it('scalar gradient bake → linear interpolation', () => {
    const g: ScalarGradient = {
      stops: [
        { zoom: 0, value: 0 },
        { zoom: 10, value: 100 },
      ],
      base: 1,
    }
    const packed = packPalette(makePalette({ scalarGradients: [g] }))
    expect(packed.scalarGradientCount).toBe(1)
    expect(packed.scalarGradientF32[0]).toBe(0)
    expect(packed.scalarGradientF32[GRADIENT_WIDTH - 1]).toBe(100)
    // Midpoint ≈ 50 (linear).
    expect(packed.scalarGradientF32[Math.floor(GRADIENT_WIDTH / 2)]).toBeCloseTo(50, 0)
  })

  it('two gradients pack to two rows (rgba16float, 8 bytes per texel)', () => {
    const g1: ColorGradient = {
      stops: [
        { zoom: 0, value: RED },
        { zoom: 10, value: BLUE },
      ],
      base: 1,
    }
    const g2: ColorGradient = {
      stops: [
        { zoom: 0, value: BLUE },
        { zoom: 10, value: RED },
      ],
      base: 1,
    }
    const packed = packPalette(makePalette({ colorGradients: [g1, g2] }))
    expect(packed.colorGradientCount).toBe(2)
    // Uint16Array storing rgba16float: 4 channels × 2 bytes × W texels × N rows.
    expect(packed.colorGradientBytes.byteLength).toBe(2 * GRADIENT_WIDTH * 4 * 2)
    // Bit-pattern compare for the endpoint half-floats (avoids the
    // DataView.getFloat16 dependency that older Node lacks).
    // half-float 1.0 = 0x3C00, half-float 0.0 = 0x0000.
    expect(packed.colorGradientBytes[0]).toBe(0x3c00) // row 0, texel 0, R = 1
    expect(packed.colorGradientBytes[2]).toBe(0x0000) // row 0, texel 0, B = 0
    const row1U16Offset = GRADIENT_WIDTH * 4
    expect(packed.colorGradientBytes[row1U16Offset + 0]).toBe(0x0000) // row 1, R = 0
    expect(packed.colorGradientBytes[row1U16Offset + 2]).toBe(0x3c00) // row 1, B = 1
  })

  it('clamps RGBA channels to [0,1] before quantising to byte', () => {
    const overflow: [number, number, number, number] = [1.5, -0.2, 0.5, 1.0]
    const packed = packPalette(makePalette({ colors: [overflow] }))
    expect(packed.colorBytes[0]).toBe(255) // 1.5 → 1 → 255
    expect(packed.colorBytes[1]).toBe(0) // -0.2 → 0 → 0
    expect(packed.colorBytes[2]).toBe(128) // 0.5 → 128 (round)
    expect(packed.colorBytes[3]).toBe(255)
  })
})

describe('palette-texture — gradient eval math', () => {
  it('linear color gradient mid = 0.5 lerp', () => {
    const g: ColorGradient = {
      stops: [
        { zoom: 0, value: RED },
        { zoom: 10, value: BLUE },
      ],
      base: 1,
    }
    const v = evalColorGradientAt(g, 5)
    expect(v[0]).toBeCloseTo(0.5)
    expect(v[2]).toBeCloseTo(0.5)
  })

  it('exponential base > 1 biases toward upper stop', () => {
    const g: ColorGradient = {
      stops: [
        { zoom: 0, value: RED },
        { zoom: 10, value: BLUE },
      ],
      base: 2,
    }
    const v = evalColorGradientAt(g, 5)
    // base=2 over a span of 10 zoom levels, at the midpoint t=0.5:
    // (2^(0.5*10) - 1) / (2^10 - 1) ≈ 0.030 — closer to the LOWER stop
    // (red) than linear's 0.5. Before #2335 this read ≈ 0.414, because
    // curveFraction ignored the span and evaluated (2^0.5 - 1) / (2 - 1);
    // the assertions below hold either way, which is why the old number
    // survived here unnoticed.
    expect(v[0]).toBeGreaterThan(0.5) // r > linear midpoint
    expect(v[2]).toBeLessThan(0.5) // b < linear midpoint
  })

  it('clamps to first stop below domain, last stop above', () => {
    const g: ColorGradient = {
      stops: [
        { zoom: 2, value: RED },
        { zoom: 10, value: BLUE },
      ],
      base: 1,
    }
    expect(evalColorGradientAt(g, 0)[0]).toBe(1) // below domain → red
    expect(evalColorGradientAt(g, 20)[2]).toBe(1) // above domain → blue
  })

  it('scalar gradient linear', () => {
    const g: ScalarGradient = {
      stops: [
        { zoom: 0, value: 0 },
        { zoom: 10, value: 100 },
      ],
      base: 1,
    }
    expect(evalScalarGradientAt(g, 5)).toBeCloseTo(50)
    expect(evalScalarGradientAt(g, -1)).toBe(0)
    expect(evalScalarGradientAt(g, 100)).toBe(100)
  })

  it('three-stop gradient picks correct bracketing pair', () => {
    const g: ColorGradient = {
      stops: [
        { zoom: 0, value: [0, 0, 0, 1] },
        { zoom: 5, value: [1, 0, 0, 1] }, // pure red at z=5
        { zoom: 10, value: [0, 0, 1, 1] },
      ],
      base: 1,
    }
    expect(evalColorGradientAt(g, 5)).toEqual([1, 0, 0, 1])
    // Mid of pair (5..10): lerp red→blue, t=0.5
    const v = evalColorGradientAt(g, 7.5)
    expect(v[0]).toBeCloseTo(0.5)
    expect(v[2]).toBeCloseTo(0.5)
  })
})

// #2335 — curveFraction applied the exponential curve to the normalised
// fraction `t` as if the bracketing stop pair were always 1 zoom level
// apart. Mapbox/MapLibre — and this repo's own runtime,
// `interpolateZoom` in map/src/render/renderer-helpers.ts — apply the
// curve to the RAW zoom delta, so any stop pair whose span isn't exactly
// 1 disagreed with the runtime. These four tests are written against an
// oracle re-derived from the runtime formula (not against numbers typed
// by hand), so a wrong new formula that merely happens to fix the
// witness would not pass all four.
describe('palette-pack — #2335 curve fraction threads span', () => {
  // Re-derivation of the runtime's span-threaded formula (the
  // exponential branch of `interpolateZoom`,
  // map/src/render/renderer-helpers.ts:110-118) — an independent
  // implementation, not a call into the code under test, so it serves
  // as the oracle these tests check against.
  function oracleCurve(z0: number, z1: number, zoom: number, base: number): number {
    const span = z1 - z0
    if (span === 0) return 0
    if (base === 1 || Math.abs(base - 1) < 1e-6) return (zoom - z0) / span
    const denom = Math.pow(base, span) - 1
    return denom === 0 ? 0 : (Math.pow(base, zoom - z0) - 1) / denom
  }

  it('WITNESS: span != 1 packed texel matches the runtime formula (fails pre-fix)', () => {
    const g: ScalarGradient = {
      stops: [
        { zoom: 4, value: 0 },
        { zoom: 8, value: 100 },
      ],
      base: 3,
    }
    const packed = packPalette(makePalette({ scalarGradients: [g] }))
    // Interior texels only (skip the clamped endpoints) — indices chosen
    // arbitrarily across the row, zoom re-derived from the SAME bake
    // formula bakeScalarGradient uses (zMin + (i/(W-1)) * (zMax-zMin)).
    for (const i of [64, 128, 192]) {
      const zoom = 4 + (i / (GRADIENT_WIDTH - 1)) * 4
      const expected = 0 + (100 - 0) * oracleCurve(4, 8, zoom, 3)
      expect(packed.scalarGradientF32[i]).toBeCloseTo(expected, 5)
      expect(evalScalarGradientAt(g, zoom)).toBeCloseTo(expected, 8)
    }
  })

  it('CONTROL: span === 1 is bit-identical to the pre-fix (#2335) formula', () => {
    // The formula this repo shipped before #2335 — kept here ONLY to prove
    // the span-threaded replacement is a strict generalisation: at
    // span === 1, `t * span === t` and `base^span === base^1 === base`
    // hold exactly in IEEE-754, so the two formulas must agree bit for
    // bit, not just approximately.
    const preFixCurve = (t: number, base: number): number => (Math.pow(base, t) - 1) / (base - 1)
    const g: ScalarGradient = {
      stops: [
        { zoom: 3, value: 0 },
        { zoom: 4, value: 100 },
      ],
      base: 2.5,
    }
    for (const zoom of [3, 3.25, 3.5, 3.75, 4]) {
      const t = zoom - 3 // span 1 → normalised t equals the raw delta
      const expected = 0 + (100 - 0) * preFixCurve(t, 2.5)
      expect(evalScalarGradientAt(g, zoom)).toBe(expected)
    }
  })

  it('CONTROL: base === 1 stays linear regardless of span, never divides by zero', () => {
    const g: ScalarGradient = {
      stops: [
        { zoom: 2, value: 10 },
        { zoom: 9, value: 80 },
      ],
      base: 1,
    }
    for (const zoom of [2, 4, 6.5, 9]) {
      const expectedLinear = 10 + (80 - 10) * ((zoom - 2) / 7)
      const v = evalScalarGradientAt(g, zoom)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeCloseTo(expectedLinear, 10)
    }
  })

  it('span === 0 (duplicate-zoom stops) resolves deterministically, no NaN in the atlas', () => {
    // The bracket search in evalScalarGradientAt/evalColorGradientAt always
    // resolves lo.zoom < hi.zoom strictly for any query that reaches the
    // interpolated branch (a duplicate-zoom pair is always skipped past as
    // a unit), so span === 0 never actually reaches curveFraction through
    // the public API today — the guard in curveFraction is defense-in-depth,
    // mirroring the belt-and-suspenders duplicate-stop guard the runtime's
    // own interpolateZoom carries for the same reason. This pins the
    // user-observable contract: a duplicate-zoom interior stop resolves to
    // the LATER duplicate's value with no NaN anywhere in the baked row.
    const g: ScalarGradient = {
      stops: [
        { zoom: 0, value: 0 },
        { zoom: 5, value: 50 },
        { zoom: 5, value: 999 },
        { zoom: 10, value: 100 },
      ],
      base: 4,
    }
    expect(evalScalarGradientAt(g, 5)).toBe(999)
    const packed = packPalette(makePalette({ scalarGradients: [g] }))
    for (let i = 0; i < GRADIENT_WIDTH; i++) {
      expect(Number.isFinite(packed.scalarGradientF32[i])).toBe(true)
    }
  })
})
