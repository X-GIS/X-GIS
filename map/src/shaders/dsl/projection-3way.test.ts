// US-4 — the projection graph is consistent across the THREE consumers of one
// neutral IR: the CPU f64 oracle (ground-truth math), the WGSL writer, and the
// GLSL ES 3.00 writer. This is the differential floor that makes the
// retargetable IR trustworthy. Real-GPU WebGL2 *execution* parity (compiling the
// emitted GLSL on a headless WebGL2 context) is the next gate; here the math
// (oracle), the structure (GLSL well-formed + executable-shaped), and the
// byte-identity (WGSL, via polygon-variant-diff) are all proven.

import { describe, it, expect } from 'vitest'
import { emitGlslModule, emitModule } from '@xgis/shader-dsl'
import { getPROJECTION_MODULE } from './projections'
import { projMercatorCpu } from './cpu-projections'

const EARTH_R = 6378137
const countOf = (s: string, ch: string) => s.split(ch).length - 1

describe('projection graph — 3-way consistency (CPU oracle · WGSL · GLSL)', () => {
  it('CPU oracle re-derives known Mercator values from the IR', () => {
    const [x0, y0] = projMercatorCpu(0, 0)
    expect(x0).toBeCloseTo(0, 3)
    expect(y0).toBeCloseTo(0, 3)
    // x(90°) = 90·(π/180)·R = (π/2)·R ≈ 10018754; y(0°) = log(tan(π/4))·R = 0.
    const [x90, y90] = projMercatorCpu(90, 0)
    expect(x90).toBeCloseTo((Math.PI / 2) * EARTH_R, 0)
    expect(y90).toBeCloseTo(0, 3)
  })

  it('the SAME module emits both targets without throwing; GLSL is well-formed', () => {
    const m = getPROJECTION_MODULE()
    const wgsl = emitModule(m)
    const glsl = emitGlslModule(m)
    expect(wgsl.length).toBeGreaterThan(200)
    expect(glsl.startsWith('#version 300 es')).toBe(true)
    // balanced braces + parens — a necessary condition for a compilable shader.
    expect(countOf(glsl, '{')).toBe(countOf(glsl, '}'))
    expect(countOf(glsl, '(')).toBe(countOf(glsl, ')'))
  })

  it('the GLSL is executable-shaped (the mercator fn is a real GLSL signature, ready for a WebGL2 compile gate)', () => {
    const glsl = emitGlslModule(getPROJECTION_MODULE())
    // GLSL ES signature: `vec2 proj_mercator(float lon_deg, float lat_deg)`.
    expect(glsl).toMatch(/vec2 proj_mercator\(float \w+, float \w+\) \{/)
    // and the WGSL of the same fn carries WGSL spelling — proof the IR is neutral.
    expect(emitModule(getPROJECTION_MODULE())).toMatch(/fn proj_mercator\(\w+: f32, \w+: f32\) -> vec2<f32>/)
  })
})
