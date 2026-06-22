import { describe, expect, it } from 'vitest'
import { emitModule } from '@xgis/shader-dsl/core/backends/wgsl'
import { getPROJECTION_MODULE } from '@xgis/shader-dsl/shaders/projections'
import { PROJECTIONS } from './projection/projections-table'

// US-P0-2: the WGSL backend regenerates the projection block. Byte-identity
// with the hand-written shader is NOT required; this checks the emitted WGSL
// is structurally well-formed and carries every projection fn + the
// table-generated dispatch ladder. Executed-on-GPU parity is US-P0-4 (e2e).
describe('shader-dsl WGSL backend — projection module', () => {
  const wgsl = emitModule(getPROJECTION_MODULE())

  it('emits the shader constants (truncated, matching the current shader)', () => {
    expect(wgsl).toContain('const PI: f32 = 3.14159265;')
    expect(wgsl).toContain('const DEG2RAD: f32 = 0.01745329;')
    expect(wgsl).toContain('const EARTH_R: f32 = 6378137.0;')
    expect(wgsl).toContain('const MERCATOR_LAT_LIMIT: f32 = 85.051129;')
  })

  it('emits every projection function signature', () => {
    for (const sig of [
      'fn proj_mercator(lon_deg: f32, lat_deg: f32) -> vec2<f32>',
      'fn wrap_lon_delta(d: f32) -> f32',
      'fn proj_equirectangular_d(lon_rel: f32, lat_deg: f32) -> vec2<f32>',
      'fn proj_natural_earth_d(lon_rel: f32, lat_deg: f32) -> vec2<f32>',
      'fn proj_orthographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32>',
      'fn proj_azimuthal_equidistant(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32>',
      'fn proj_stereographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32>',
      'fn oblique_rot(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32>',
      'fn proj_oblique_mercator_d(lam_rot: f32, phi_rot: f32) -> vec2<f32>',
      'fn proj_globe(lon_deg: f32, lat_deg: f32) -> vec3<f32>',
      'fn center_cos_c(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> f32',
      'fn project(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> vec2<f32>',
      'fn project_geom(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>, ref_lon: f32) -> vec2<f32>',
      'fn needs_backface_cull(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32',
      'fn rim_alpha(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32',
      'fn inv_merc_lat_rad(merc_y_m: f32) -> f32',
    ]) {
      expect(wgsl, `missing ${sig}`).toContain(sig)
    }
  })

  it('the dispatch ladder is generated from the PROJECTIONS table (one arm per non-globe projType)', () => {
    // project() forward dispatch — thresholds at projType+0.5, table-ordered.
    const flat = PROJECTIONS.filter((p) => !p.isGlobe)
    for (let i = 0; i < flat.length - 1; i++) {
      expect(wgsl, `dispatch arm t < ${flat[i].projType + 0.5}`).toContain(`< ${flat[i].projType + 0.5})`)
    }
    // calls each projection's forward
    expect(wgsl).toContain('proj_mercator(lon_deg, lat_deg)')
    expect(wgsl).toMatch(/proj_oblique_mercator\([\s\S]*?proj_params/)
  })

  it('back-face cull thresholds come from the table (no hardcoded drift)', () => {
    // azimuthal -0.85, stereographic -0.8 in the WGSL select / smoothstep.
    expect(wgsl).toContain('-0.85')
    expect(wgsl).toContain('-0.8')
    // WGSL select(false, true, cond) form
    expect(wgsl).toMatch(/select\(-1\.0, 1\.0, \(\w+ > -0\.85\)\)/)
  })

  it('is structurally balanced (braces + parens)', () => {
    expect((wgsl.match(/{/g) ?? []).length).toBe((wgsl.match(/}/g) ?? []).length)
    expect((wgsl.match(/\(/g) ?? []).length).toBe((wgsl.match(/\)/g) ?? []).length)
  })
})
