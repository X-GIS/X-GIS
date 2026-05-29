import { describe, it, expect } from 'vitest'
import { emitPointWgsl } from './point'

// Phase-2 point (SDF marker) shader — exercises storage<read> bindings with
// runtime-sized arrays + bitwise unpacking of per-feature flags. No pick
// variant (the point fragment carries no pick channel). Not cpu-evaluated
// (storage + fwidth + many extern fn calls); the gate is the emission shape
// + the GPU pixel survey.
describe('Phase-2 point shader — DSL emission', () => {
  const w = emitPointWgsl()
  const pointPart = w.slice(w.indexOf('struct Uniforms'))

  it('prepends the shared projection + log-depth WGSL the vs/fs call', () => {
    expect(w).toContain('proj_globe')
    expect(w).toContain('inv_merc_lat_rad')
    expect(w).toContain('needs_backface_cull')
    expect(w).toContain('fn rim_alpha')
    expect(w).toContain('fn apply_log_depth')
    expect(w).toContain('fn compute_log_frag_depth')
  })
  it('uniform + 3 storage<read> bindings with runtime-sized arrays', () => {
    expect(pointPart).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
    expect(pointPart).toContain('@group(0) @binding(1) var<storage, read> feat_data: array<f32>;')
    expect(pointPart).toContain('@group(0) @binding(2) var<storage, read> shapes: array<ShapeDesc>;')
    expect(pointPart).toContain('@group(0) @binding(3) var<storage, read> segments: array<Segment>;')
  })
  it('vertex inputs: center / quad_id / feat_id', () => {
    expect(pointPart).toContain('@vertex')
    expect(pointPart).toContain('fn vs_point(@location(0) center: vec2<f32>, @location(1) quad_id: u32, @location(2) feat_id: f32) -> PointOut')
  })
  it('fragment: discard on backface + fwidth AA + log-depth write', () => {
    expect(pointPart).toContain('@fragment')
    expect(pointPart).toContain('fn fs_point(in: PointOut) -> PointFragmentOutput')
    expect(pointPart).toContain('discard;')
    expect(pointPart).toContain('fwidth(length(in.uv))')
    expect(pointPart).toContain('compute_log_frag_depth(in.view_w')
  })
  it('bitwise unpacking of per-feature flags (>> << & on u32)', () => {
    expect(pointPart).toContain('(packed10 >> 4u)')           // size_mode
    expect(pointPart).toContain('((packed10 >> 8u) & 3u)')    // anchor_mode
    expect(pointPart).toContain('(packed10 & 8u)')            // is_flat bit
    expect(pointPart).toContain('(flags & 1u)')               // fill
    expect(pointPart).toContain('(flags & 2u)')               // stroke
    expect(pointPart).toContain('(flags & 4u)')               // glow
  })
  it('VS re-centers ABSOLUTE per-feature ECEF against the camera (DSFUN)', () => {
    // Camera-relative RTC fix: per-feature ECEF DSFUN is absolute, so the VS
    // subtracts the camera anchor (u.cam_ecef_h/l) before the MVP. Without
    // this, every point collapses toward the camera-at-ENU-origin MVP origin.
    expect(pointPart).toContain('cam_ecef_h')
    expect(pointPart).toContain('cam_ecef_l')
    const vsBody = pointPart.slice(pointPart.indexOf('fn vs_point'))
    const vsOnly = vsBody.slice(0, vsBody.indexOf('fn fs_point'))
    expect(vsOnly).toContain('u.cam_ecef_h')
    expect(vsOnly).toContain('u.cam_ecef_l')
  })
  it('SDF helpers + switch on segment kind', () => {
    expect(pointPart).toContain('fn dist_to_line')
    expect(pointPart).toContain('fn dist_to_quadratic')
    expect(pointPart).toContain('fn dist_to_cubic')
    expect(pointPart).toContain('fn winding_line')
    expect(pointPart).toContain('fn sdf_shape')
    expect(pointPart).toContain('switch seg.kind')
  })
  it('is structurally balanced (point module portion)', () => {
    expect((pointPart.match(/{/g) ?? []).length).toBe((pointPart.match(/}/g) ?? []).length)
    expect((pointPart.match(/\(/g) ?? []).length).toBe((pointPart.match(/\)/g) ?? []).length)
  })
})
