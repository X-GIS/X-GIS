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
  coverageGridIndexCount,
  coverageNodeCount,
} from './coverage-ramp'
import { emitGlslModule } from '@xgis/shader-dsl'

const wgsl = emitCoverageWgsl()
const glslFrag = emitGlslModule(buildCoverageModule(), 'fragment')
const glslVert = emitGlslModule(buildCoverageModule(), 'vertex')

describe('coverage-ramp dsl emission (projection-general drape)', () => {
  it('the mesh is still an N×N tessellation — now INDEXED, not decoded from vertex_index', () => {
    // The drape is still a fine mesh (that is what keeps it projection-general); #1366
    // INC-3 only moved WHERE the topology is built. It used to be decoded in the shader
    // from vertex_index (cell = vid/6, cx = cell % N); it is now a CPU index buffer, so
    // the vertex stage consumes attributes and does no grid arithmetic at all.
    const vsCov = wgsl.match(/fn vs_cov[\s\S]*?\n\}/)?.[0] ?? ''
    expect(vsCov).not.toBe('')
    expect(vsCov).not.toMatch(/vertex_index/)
    expect(vsCov).not.toMatch(/%/) // no grid-cell split left in the shader
    // The tessellation itself is unchanged and asserted on the CPU counts.
    expect(coverageGridIndexCount()).toBe(COVERAGE_GRID_N * COVERAGE_GRID_N * 6)
    expect(coverageNodeCount()).toBe((COVERAGE_GRID_N + 1) * (COVERAGE_GRID_N + 1))
    // uint16 indices are only valid while the node count stays under 65 536.
    expect(coverageNodeCount()).toBeLessThan(65536)
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
    // #1366 INC-3 — uv is now CARRIED, not recovered. The VsOut struct holds uv and no
    // lon/lat varying at all: the fragment must not be able to reconstruct uv from
    // geography, because for a projected (UTM) grid uv is NOT affine in lon/lat.
    expect(vsOut).toMatch(/\buv\b/)
    expect(vsOut).not.toMatch(/\blat\b/)
    expect(vsOut).not.toMatch(/\blon\b/)
  })

  it('the geographic-rectangle assumption has NO representation left (#1366 INC-3)', () => {
    // `cov_edges` (the lon/lat footprint rect) and `cov_geo` (the u/v denominators) both
    // encoded "the footprint is a rectangle in lon/lat" — false for a projected cell.
    // They are gone from the uniform block entirely, so nothing can re-derive from them;
    // asserting their ABSENCE is what stops the assumption creeping back.
    for (const [src, label] of [
      [wgsl, 'wgsl'],
      [glslVert, 'glslVert'],
      [glslFrag, 'glslFrag'],
    ] as const) {
      expect(src, label).not.toMatch(/cov_edges/)
      expect(src, label).not.toMatch(/cov_geo/)
    }
  })

  it('the vertex stage READS node lon/lat as an attribute instead of deriving it', () => {
    // The load-bearing shape of INC-3: geography enters the vertex stage as data the CPU
    // reprojected through the cell's own CRS, not as arithmetic over a lon/lat rectangle.
    // A regression to `mix(edges, u01)` would drop these attribute declarations.
    expect(wgsl).toMatch(/@location\(0\)\s+node_lonlat/)
    expect(wgsl).toMatch(/@location\(1\)\s+node_uv/)
    // GLSL renames varyings but keeps attribute names for the vertex stage.
    expect(glslVert).toMatch(/node_lonlat/)
    expect(glslVert).toMatch(/node_uv/)
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
    expect(coverageGridIndexCount()).toBe(COVERAGE_GRID_N * COVERAGE_GRID_N * 6)
  })

  it('both stages emit as non-empty strings on both backends (WebGL2 twin lands)', () => {
    expect(wgsl.length).toBeGreaterThan(200)
    expect(glslFrag.length).toBeGreaterThan(100)
    expect(glslVert.length).toBeGreaterThan(100)
    expect(glslFrag).toContain('cov_lut') // the LUT sample maps t → colour on both targets
  })
})
