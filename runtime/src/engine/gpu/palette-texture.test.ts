// ═══════════════════════════════════════════════════════════════════
// palette-texture.ts — pure pack + gradient evaluation tests
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
} from './palette-texture'
import type { Palette, ColorGradient, ScalarGradient } from '@xgis/compiler'

const RED: [number, number, number, number] = [1, 0, 0, 1]
const BLUE: [number, number, number, number] = [0, 0, 1, 1]

function makePalette(p: Partial<Palette>): Palette {
  const colors = (p.colors ?? []) as readonly [number, number, number, number][]
  const scalars = (p.scalars ?? []) as readonly number[]
  const colorGradients = (p.colorGradients ?? []) as readonly ColorGradient[]
  const scalarGradients = (p.scalarGradients ?? []) as readonly ScalarGradient[]
  return {
    colors, scalars, colorGradients, scalarGradients,
    findColor() { return -1 },
    findScalar() { return -1 },
    findColorGradient() { return -1 },
    findScalarGradient() { return -1 },
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
    expect(packed.colorGradientBytes.byteLength).toBe(GRADIENT_WIDTH * 4)
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

  it('color gradient bake → both endpoints exact, midpoint interpolated', () => {
    const g: ColorGradient = {
      stops: [{ zoom: 0, value: RED }, { zoom: 10, value: BLUE }],
      base: 1,
    }
    const packed = packPalette(makePalette({ colorGradients: [g] }))
    expect(packed.colorGradientCount).toBe(1)
    // First texel = stop 0 (red)
    expect(packed.colorGradientBytes[0]).toBe(255)
    expect(packed.colorGradientBytes[1]).toBe(0)
    expect(packed.colorGradientBytes[2]).toBe(0)
    // Last texel = stop 1 (blue)
    const lastPx = (GRADIENT_WIDTH - 1) * 4
    expect(packed.colorGradientBytes[lastPx]).toBe(0)
    expect(packed.colorGradientBytes[lastPx + 1]).toBe(0)
    expect(packed.colorGradientBytes[lastPx + 2]).toBe(255)
    // Midpoint (t = 0.5) under linear curve → r=g=b≈127, exactly
    // halfway between red and blue components.
    const midPx = Math.floor(GRADIENT_WIDTH / 2) * 4
    expect(Math.abs(packed.colorGradientBytes[midPx]! - 127)).toBeLessThanOrEqual(2)
    expect(Math.abs(packed.colorGradientBytes[midPx + 2]! - 127)).toBeLessThanOrEqual(2)
  })

  it('color gradient meta encodes (zMin, zMax, base, _pad)', () => {
    const g: ColorGradient = {
      stops: [{ zoom: 2, value: RED }, { zoom: 15, value: BLUE }],
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
      stops: [{ zoom: 0, value: 0 }, { zoom: 10, value: 100 }],
      base: 1,
    }
    const packed = packPalette(makePalette({ scalarGradients: [g] }))
    expect(packed.scalarGradientCount).toBe(1)
    expect(packed.scalarGradientF32[0]).toBe(0)
    expect(packed.scalarGradientF32[GRADIENT_WIDTH - 1]).toBe(100)
    // Midpoint ≈ 50 (linear).
    expect(packed.scalarGradientF32[Math.floor(GRADIENT_WIDTH / 2)]).toBeCloseTo(50, 0)
  })

  it('two gradients pack to two rows', () => {
    const g1: ColorGradient = { stops: [{ zoom: 0, value: RED }, { zoom: 10, value: BLUE }], base: 1 }
    const g2: ColorGradient = { stops: [{ zoom: 0, value: BLUE }, { zoom: 10, value: RED }], base: 1 }
    const packed = packPalette(makePalette({ colorGradients: [g1, g2] }))
    expect(packed.colorGradientCount).toBe(2)
    expect(packed.colorGradientBytes.byteLength).toBe(2 * GRADIENT_WIDTH * 4)
    // Row 0 starts with red, row 1 starts with blue.
    expect(packed.colorGradientBytes[0]).toBe(255)  // r
    const row1Start = GRADIENT_WIDTH * 4
    expect(packed.colorGradientBytes[row1Start + 2]).toBe(255)  // b
  })

  it('clamps RGBA channels to [0,1] before quantising to byte', () => {
    const overflow: [number, number, number, number] = [1.5, -0.2, 0.5, 1.0]
    const packed = packPalette(makePalette({ colors: [overflow] }))
    expect(packed.colorBytes[0]).toBe(255)  // 1.5 → 1 → 255
    expect(packed.colorBytes[1]).toBe(0)    // -0.2 → 0 → 0
    expect(packed.colorBytes[2]).toBe(128)  // 0.5 → 128 (round)
    expect(packed.colorBytes[3]).toBe(255)
  })
})

describe('palette-texture — gradient eval math', () => {
  it('linear color gradient mid = 0.5 lerp', () => {
    const g: ColorGradient = {
      stops: [{ zoom: 0, value: RED }, { zoom: 10, value: BLUE }],
      base: 1,
    }
    const v = evalColorGradientAt(g, 5)
    expect(v[0]).toBeCloseTo(0.5)
    expect(v[2]).toBeCloseTo(0.5)
  })

  it('exponential base > 1 biases toward upper stop', () => {
    const g: ColorGradient = {
      stops: [{ zoom: 0, value: RED }, { zoom: 10, value: BLUE }],
      base: 2,
    }
    const v = evalColorGradientAt(g, 5)
    // base=2 curve at t=0.5: (2^0.5 - 1) / (2 - 1) ≈ 0.414 — closer
    // to the LOWER stop (red) than linear's 0.5.
    expect(v[0]).toBeGreaterThan(0.5)  // r > linear midpoint
    expect(v[2]).toBeLessThan(0.5)     // b < linear midpoint
  })

  it('clamps to first stop below domain, last stop above', () => {
    const g: ColorGradient = {
      stops: [{ zoom: 2, value: RED }, { zoom: 10, value: BLUE }],
      base: 1,
    }
    expect(evalColorGradientAt(g, 0)[0]).toBe(1)   // below domain → red
    expect(evalColorGradientAt(g, 20)[2]).toBe(1)  // above domain → blue
  })

  it('scalar gradient linear', () => {
    const g: ScalarGradient = {
      stops: [{ zoom: 0, value: 0 }, { zoom: 10, value: 100 }],
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
        { zoom: 5, value: [1, 0, 0, 1] },   // pure red at z=5
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
