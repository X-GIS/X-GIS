import { describe, it, expect } from 'vitest'
import { emitRasterWgsl } from './raster'

// Phase-2 raster shader — the largest texture shader: a procedural-grid vertex
// with a 4-branch projection dispatch (globe / mercator / equirect / other+cull)
// and a log-depth fragment. The projection + log-depth math is the shared
// DSL-emitted WGSL (prepended by emitRasterWgsl), so vs/fs call proj_globe /
// project_geom / center_cos_c / apply_log_depth / compute_log_frag_depth by
// name. It is not cpu-evaluated (those fns live outside the raster module); the
// gate is the emission shape + the GPU pixel survey (OFM Liberty natural-earth
// raster relief exercises the Mercator branch).
describe('Phase-2 raster shader — DSL emission', () => {
  const noPick = emitRasterWgsl(false)
  const pick = emitRasterWgsl(true)
  const rasterPart = (w: string) => w.slice(w.indexOf('struct Uniforms'))

  it('prepends the shared projection + log-depth WGSL the vs/fs call', () => {
    expect(noPick).toContain('proj_globe')
    expect(noPick).toContain('project_geom')
    expect(noPick).toContain('center_cos_c')
    expect(noPick).toContain('fn apply_log_depth')
    expect(noPick).toContain('fn compute_log_frag_depth')
  })
  it('binds u (g0b0) + texture/sampler (g0b1/b2) + tile (g1b0)', () => {
    expect(noPick).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
    expect(noPick).toContain('@group(0) @binding(1) var tex: texture_2d<f32>;')
    expect(noPick).toContain('@group(0) @binding(2) var tex_sampler: sampler;')
    expect(noPick).toContain('@group(1) @binding(0) var<uniform> tile: TileUniforms;')
  })
  it('procedural-grid vertex + 4-branch projection dispatch', () => {
    expect(noPick).toContain('@vertex\nfn vs_tile(@builtin(vertex_index) vid: u32) -> VsOut')
    expect(noPick).toContain('(t > 6.5)')   // globe
    expect(noPick).toContain('(t < 0.5)')   // mercator
    expect(noPick).toContain('(t < 1.5)')   // equirect
    expect(noPick).toContain('array<u32, 6>')
  })
  it('fragment samples the tile + rim fade + log-depth', () => {
    expect(noPick).toContain('@fragment\nfn fs_tile(input: VsOut) -> RasterFragmentOutput')
    expect(noPick).toContain('textureSample(tex, tex_sampler, input.uv)')
    expect(noPick).toContain('smoothstep(0.0, 0.02, input.vis)')
    expect(noPick).toContain('compute_log_frag_depth(input.view_w')
  })
  it('pick variant toggles the pick field + write', () => {
    expect(noPick).not.toContain('pick: vec2<u32>')
    expect(noPick).not.toContain('out.pick')
    expect(pick).toContain('@location(1) @interpolate(flat) pick: vec2<u32>,')
    expect(pick).toContain('out.pick = vec2<u32>(0u, 0u);')
  })
  it('both variants are structurally balanced (raster module portion)', () => {
    for (const w of [rasterPart(noPick), rasterPart(pick)]) {
      expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
      expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
    }
  })
})
