import { describe, it, expect } from 'vitest'
import { emitRasterWgsl } from './raster'

// Phase-2 PR 2d.3 raster shader — ECEF VS rewrite. The vertex stage uses a
// single ECEF path (lon/lat → lonlat_to_ecef → subtract tile_ecef_center →
// MVP) replacing the old 4-branch projection dispatch. The fragment is
// unchanged: sample + rim fade + log-depth.
describe('Phase-2 raster shader — DSL emission (ECEF VS, PR 2d.3)', () => {
  const noPick = emitRasterWgsl(false)
  const pick = emitRasterWgsl(true)
  const rasterPart = (w: string) => w.slice(w.indexOf('struct Uniforms'))

  it('prepends ECEF consts + lonlat_to_ecef fn + log-depth fns', () => {
    expect(noPick).toContain('lonlat_to_ecef')
    expect(noPick).toContain('fn apply_log_depth')
    expect(noPick).toContain('fn compute_log_frag_depth')
    // ECEF consts: WGS84 semi-major axis
    expect(noPick).toContain('6378137')
  })
  it('prepends PI and DEG2RAD consts (regression: PR 2d.3 WGSL compile fix)', () => {
    // vs_tile uses constRef('PI') and constRef('DEG2RAD'); these must be defined
    // before the DSL-emitted module or WGSL compile fails with "unresolved value".
    expect(noPick).toContain('const PI:')
    expect(noPick).toContain('const DEG2RAD:')
  })
  it('binds u (g0b0) + texture/sampler (g0b1/b2) + tile (g1b0)', () => {
    expect(noPick).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
    expect(noPick).toContain('@group(0) @binding(1) var tex: texture_2d<f32>;')
    expect(noPick).toContain('@group(0) @binding(2) var tex_sampler: sampler;')
    expect(noPick).toContain('@group(1) @binding(0) var<uniform> tile: TileUniforms;')
  })
  it('TileUniforms has tile_ecef_center (not tile_rtc)', () => {
    expect(noPick).toContain('tile_ecef_center')
    expect(noPick).not.toContain('tile_rtc')
  })
  it('procedural-grid vertex + single ECEF projection path', () => {
    expect(noPick).toContain('@vertex\nfn vs_tile(@builtin(vertex_index) vid: u32) -> VsOut')
    expect(noPick).toContain('lonlat_to_ecef(')
    // Camera-relative RTC fix: the VS now subtracts the frame cameraCenter
    // (u.cam_ecef_center) rather than the per-tile tile_ecef_center, so the
    // ECEF vertex projects vertex − cameraCenter through the camera-at-origin MVP.
    expect(noPick).toContain('u.cam_ecef_center')
    expect(noPick).toContain('array<u32, 6>')
    // No old projection-dispatch branches
    const vsBody = noPick.slice(noPick.indexOf('@vertex\nfn vs_tile'))
    const vsEnd = vsBody.indexOf('\n@fragment')
    const vsOnly = vsEnd > 0 ? vsBody.slice(0, vsEnd) : vsBody
    expect(vsOnly).not.toContain('proj_globe')
    expect(vsOnly).not.toContain('project_geom')
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
