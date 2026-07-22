// ═══ coverage-ramp shader — dsl-emission gate (#1158 GAP-1 / INC-B step 1) ═══
//
// Gate 3 (headed real-GPU readback) CANNOT run in this environment, so the load-bearing
// SHAPE is pinned HERE by asserting both the WGSL and the GLSL (WebGL2 twin) emit:
//   1. a TESSELLATED surface grid — the vertex stage decodes vertex_index into an N×N
//      grid (a modulo + the COVERAGE_GRID_N constant), replacing the single quad, and
//      projects each vertex via the general `project()`. This is what makes the drape
//      projection-general instead of Mercator-only.
//   2. NO baked inverse-Mercator (atan(exp(…))) and NO merc_y varying — the fragment
//      reads its UV straight from the interpolated latitude varying (`lat`).
//   3. the VALIDITY-WEIGHTED division s' = value/valid, so nodata never contaminates
//      neighbour values (A3).

import { describe, it, expect } from 'vitest'
import {
  emitCoverageWgsl,
  buildCoverageModule,
  COVERAGE_GRID_N,
  coverageGridVertexCount,
} from './coverage-ramp'
import { emitGlslModule } from '@xgis/shader-dsl'

const wgsl = emitCoverageWgsl()
const glslFrag = emitGlslModule(buildCoverageModule(), 'fragment')
const glslVert = emitGlslModule(buildCoverageModule(), 'vertex')

describe('coverage-ramp dsl emission (projection-general drape)', () => {
  it('the vertex stage tessellates vertex_index into an N×N grid (WGSL + GLSL)', () => {
    // A single quad has no modulo and no grid constant; the tessellated grid decode
    // (cell = vid/6, cx = cell % N, …) emits both. That distinguishes the two.
    for (const [src, label] of [
      [wgsl, 'wgsl'],
      [glslVert, 'glslVert'],
    ] as const) {
      expect(src, label).toMatch(/%/) // integer modulo — the grid-cell split
      expect(src, label).toContain(String(COVERAGE_GRID_N)) // the grid N (64)
    }
  })

  it('the vertex stage projects per-vertex via the shared projection dispatch', () => {
    // `project()` emits the projection funcs (proj_mercator / proj_natural_earth / …);
    // their presence is what makes the drape correct for EVERY flat projection.
    expect(wgsl).toMatch(/proj_|project/)
    expect(glslVert).toMatch(/proj_|project/)
  })

  it('the coverage stages do NO inverse-Mercator — UV from the interpolated lat varying', () => {
    // The old single-quad recovered latitude per-fragment via the Gudermannian
    // (atan(exp(mercY))) — correct ONLY under Mercator. The coverage vs/fs bodies now do
    // NO trig (project() is a shared-func CALL; the fs is a pure UV lookup). Scope the
    // check to the coverage function bodies — the shared projection funcs legitimately
    // use atan/exp and are emitted alongside (whole-module matching would false-positive).
    const vsCov = wgsl.match(/fn vs_cov[\s\S]*?\n\}/)?.[0] ?? ''
    const fsCov = wgsl.match(/fn fs_cov[\s\S]*?\n\}/)?.[0] ?? ''
    expect(vsCov).not.toBe('')
    expect(fsCov).not.toBe('')
    expect(vsCov).not.toMatch(/atan|exp\(/)
    expect(fsCov).not.toMatch(/atan|exp\(/)
    // merc_y is gone from the COVERAGE bodies + the VsOut struct (the shared projection
    // funcs keep their own internal merc_y locals, so scope the check — not whole-module).
    const vsOut = wgsl.match(/struct CovVsOut\s*\{[^}]*\}/)?.[0] ?? ''
    expect(vsOut).not.toBe('')
    expect(vsCov).not.toMatch(/merc_y/)
    expect(fsCov).not.toMatch(/merc_y/)
    expect(vsOut).not.toMatch(/merc_y/)
    // the VsOut struct carries + the fragment reads the `lat` varying (UV from latitude).
    expect(vsOut).toMatch(/\blat\b/)
    expect(fsCov).toMatch(/\.lat\b/)
    // GLSL varyings are renamed by the backend, so pin the coverage-specific signal that
    // the fragment computes its UV from the geo edges (not a linear texture-V): cov_geo.
    expect(glslFrag).toMatch(/cov_geo/)
  })

  it('WGSL + GLSL both perform the validity-weighted division (value ÷ valid)', () => {
    // Match the ACTUAL division of the value tap by the validity tap — not just any `/`.
    // Emitted as `…(cov_value, …).x / _cseN`; replacing sPrime with the raw value tap
    // drops the `/` after `.x` → the A3 rim regression.
    for (const src of [wgsl, glslFrag]) {
      expect(src).toContain('cov_value')
      expect(src).toContain('cov_valid')
      expect(src).toContain('cov_lut')
      expect(src).toMatch(/cov_value[^)]*\)\.x\s*\/\s*\w/)
    }
  })

  it('the fragment multiplies output alpha by the layer opacity (ramp_params.z)', () => {
    // Coverage respects the LAYER's opacity paint (#1158) so it can blend over a basemap
    // (e.g. currents over satellite imagery). alpha = validity · opacity via ramp_params.z.
    const fsCov = wgsl.match(/fn fs_cov[\s\S]*?\n\}/)?.[0] ?? ''
    expect(fsCov).toMatch(/ramp_params\.z/)
    expect(glslFrag).toMatch(/ramp_params/)
  })

  it('the draw count matches the N×N·6 tessellation', () => {
    expect(coverageGridVertexCount()).toBe(COVERAGE_GRID_N * COVERAGE_GRID_N * 6)
  })

  it('both stages emit as non-empty strings on both backends (WebGL2 twin lands)', () => {
    expect(wgsl.length).toBeGreaterThan(200)
    expect(glslFrag.length).toBeGreaterThan(100)
    expect(glslVert.length).toBeGreaterThan(100)
    expect(glslFrag).toContain('cov_lut') // the LUT sample maps t → colour on both targets
  })
})
