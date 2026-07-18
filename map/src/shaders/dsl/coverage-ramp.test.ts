// ═══ coverage-ramp shader — dsl-emission gate (#1158 GAP-1 INC-A / A4) ═══
//
// Gate 3 (headed real-GPU readback) CANNOT run in this environment, so the two
// load-bearing formulas are pinned HERE by asserting both the WGSL and the GLSL
// (WebGL2 twin) emit contain them:
//   1. the INVERSE-MERCATOR row mapping — lat recovered per-fragment from the
//      interpolated Mercator-Y (atan(exp(…)) = the Gudermannian) — and NOT a linear
//      V interpolated over the quad (the flaw the doc misses, A4).
//   2. the VALIDITY-WEIGHTED division s' = value/valid, so nodata never contaminates
//      neighbour values (A3).

import { describe, it, expect } from 'vitest'
import { emitCoverageWgsl, buildCoverageModule } from './coverage-ramp'
import { emitGlslModule } from '@xgis/shader-dsl'

const wgsl = emitCoverageWgsl()
const glslFrag = emitGlslModule(buildCoverageModule(), 'fragment')
const glslVert = emitGlslModule(buildCoverageModule(), 'vertex')

describe('coverage-ramp dsl emission (A4)', () => {
  it('WGSL + GLSL both invert Mercator per-fragment (atan(exp(…)) = atan(sinh))', () => {
    // The portable Gudermannian: 2·atan(exp(mercY)) − π/2 ≡ atan(sinh(mercY)).
    expect(wgsl).toMatch(/atan\(\s*exp\(/)
    expect(glslFrag).toMatch(/atan\(\s*exp\(/)
  })

  it('WGSL + GLSL both perform the validity-weighted division (value ÷ valid)', () => {
    // Match the ACTUAL division of the value tap by the validity tap — not just any `/`
    // (the shader also emits `1.0 / 512.0` for the discard threshold + preamble slashes,
    // so a bare /\// stays green even if s' = value/w is removed, the A3 rim regression).
    // Emitted as `…(cov_value, …).x / _cseN` on both backends (WGSL textureSample / GLSL
    // texture); replacing sPrime with the raw value tap drops the `/` after `.x` → fails.
    for (const src of [wgsl, glslFrag]) {
      expect(src).toContain('cov_value')
      expect(src).toContain('cov_valid')
      expect(src).toContain('cov_lut')
      expect(src).toMatch(/cov_value[^)]*\)\.x\s*\/\s*\w/)
    }
  })

  it('the fragment derives V from latitude — no linear texture-V varying (WGSL + GLSL)', () => {
    // The vertex passes the Mercator-Y varying (merc_y), NOT a precomputed texture V; the
    // fragment computes v from the inverse-projected latitude. Neither backend's vertex
    // output carries a `v_tex`/`uv` varying (checked on the GLSL VERTEX too, not just WGSL).
    for (const [src, label] of [
      [wgsl, 'wgsl'],
      [glslVert, 'glslVert'],
    ] as const) {
      expect(src, label).toContain('merc_y')
      expect(src, label).not.toMatch(/\bv_tex\b/)
    }
    // WGSL: the VsOut struct carries lon + merc_y only (no v/uv location output).
    const vsOutFields = wgsl.match(/struct CovVsOut\{[^}]*\}/s)?.[0] ?? wgsl
    expect(vsOutFields).not.toMatch(/\buv\s*:/)
    // GLSL vertex: its varying outputs are lon + merc_y only (no `out … uv` varying).
    expect(glslVert).not.toMatch(/\bout\s+\w+\s+uv\b/)
  })

  it('both stages emit as non-empty strings on both backends (WebGL2 twin lands)', () => {
    expect(wgsl.length).toBeGreaterThan(200)
    expect(glslFrag.length).toBeGreaterThan(100)
    expect(glslVert.length).toBeGreaterThan(100)
    // the LUT sample maps t → colour on both targets
    expect(glslFrag).toContain('cov_lut')
  })
})
