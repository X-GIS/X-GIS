import { describe, it, expect } from 'vitest'
import { module } from '@xgis/shader-dsl'
import { compileModule } from '@xgis/shader-dsl'
import { ECEF_CONSTS } from './ecef'
import { RASTER_COLOR_FUNCS } from './raster-color'

// The DSL raster colour-adjust must compute exactly MapLibre's raster.fragment.glsl math.
// Evaluated on the CPU backend vs a plain JS reference (the absorption is not byte-identical
// to the old raw WGSL, so math-equivalence is the gate). DEG2RAD_F comes from ECEF_CONSTS.
const D2R = 0.017453292519943295
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function spin(angleRad: number): number[] {
  const s = Math.sin(angleRad)
  const c = Math.cos(angleRad)
  const r3 = 1.7320508075688772
  return [(2 * c + 1) / 3, (-r3 * s - c + 1) / 3, (r3 * s - c + 1) / 3]
}
function adjust(rgbIn: number[], p0: number[], p1: number[]): number[] {
  const [hueDeg, bLow, bHigh, sat] = p0
  const contrast = p1[0]
  const w = spin(hueDeg * D2R)
  let rgb = [
    dot(rgbIn, [w[0], w[1], w[2]]),
    dot(rgbIn, [w[2], w[0], w[1]]),
    dot(rgbIn, [w[1], w[2], w[0]]),
  ]
  rgb = rgb.map((v) => bLow + (bHigh - bLow) * v)
  const satF = sat > 0 ? 1 - 1 / (1.001 - sat) : -sat
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
  rgb = rgb.map((v) => v + (avg - v) * satF)
  const cF = contrast > 0 ? 1 / (1 - contrast) : 1 + contrast
  rgb = rgb.map((v) => (v - 0.5) * cF + 0.5)
  return rgb.map((v) => Math.max(0, Math.min(1, v)))
}

const M = compileModule(module({ consts: ECEF_CONSTS, funcs: RASTER_COLOR_FUNCS }))

describe('raster-color DSL — CPU eval matches the MapLibre reference', () => {
  const cases: Array<{ rgb: number[]; p0: number[]; p1: number[] }> = [
    { rgb: [0.5, 0.6, 0.7], p0: [0, 0, 1, 0], p1: [0, 0, 0, 0] }, // DEFAULT — must be a no-op
    { rgb: [0.2, 0.4, 0.8], p0: [90, 0, 1, 0], p1: [0, 0, 0, 0] }, // hue
    { rgb: [0.2, 0.4, 0.8], p0: [0, 0.1, 0.9, 0], p1: [0, 0, 0, 0] }, // brightness
    { rgb: [0.2, 0.4, 0.8], p0: [0, 0, 1, 0.5], p1: [0, 0, 0, 0] }, // saturation +
    { rgb: [0.2, 0.4, 0.8], p0: [0, 0, 1, -0.5], p1: [0, 0, 0, 0] }, // saturation -
    { rgb: [0.2, 0.4, 0.8], p0: [0, 0, 1, 0], p1: [0.5, 0, 0, 0] }, // contrast +
    { rgb: [0.2, 0.4, 0.8], p0: [30, 0.2, 0.8, 0.3], p1: [0.2, 0, 0, 0] }, // combined
  ]
  for (const { rgb, p0, p1 } of cases) {
    it(`raster_color_adjust(${rgb}, ${p0}, ${p1.slice(0, 1)})`, () => {
      const got = M.fns.raster_color_adjust(rgb, p0, p1) as number[]
      const r = adjust(rgb, p0, p1)
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(r[i], 5)
    })
  }

  it('the default params are a hard no-op (texel unchanged)', () => {
    const got = M.fns.raster_color_adjust([0.3, 0.55, 0.9], [0, 0, 1, 0], [0, 0, 0, 0]) as number[]
    expect(got[0]).toBeCloseTo(0.3, 5)
    expect(got[1]).toBeCloseTo(0.55, 5)
    expect(got[2]).toBeCloseTo(0.9, 5)
  })
})
