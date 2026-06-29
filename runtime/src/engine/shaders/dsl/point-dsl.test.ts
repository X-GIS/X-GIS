import { describe, it, expect } from 'vitest'
import { emitPointWgsl } from './point'

// Phase-2 point (SDF marker) shader — exercises storage<read> bindings with
// runtime-sized arrays + bitwise unpacking of per-feature flags. No pick
// variant (the point fragment carries no pick channel). Not cpu-evaluated
// (storage + fwidth + many extern fn calls); the gate is the emission shape
// + the GPU pixel survey.
describe('Phase-2 point shader — DSL emission', () => {
  // Structural contracts assert the AUTHORED shape -> emit at O1 (production is O2,
  // which inlines single-call prelude helpers + tree-shakes unused ones).
  const w = emitPointWgsl('O1')
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
    // length(in.uv) is reused (AA edge + radial falloff), so the cse auto-cache binds it
    // to a shared temp — assert the uv-distance is computed and fwidth AA is applied,
    // not the pre-cse inline `fwidth(length(in.uv))` spelling.
    expect(pointPart).toContain('length(in.uv)')
    expect(pointPart).toContain('fwidth(')
    expect(pointPart).toContain('compute_log_frag_depth(in.view_w')
  })
  it('bitwise unpacking of per-feature flags (>> << & on u32)', () => {
    // The hand `let packed10` / `let flags` bindings were dropped; the packed-byte
    // expression is now either inlined (single use) or hoisted to a cse temp. Pin
    // the SHIFT/MASK literals — the bitfield each extraction selects — not the
    // operand name, which is no longer a stable identifier.
    expect(pointPart).toMatch(/>> 4u\) & 15u/)   // size_mode  (>> 4, mask 0xF)
    expect(pointPart).toMatch(/>> 8u\) & 3u/)    // anchor_mode (>> 8, mask 3)
    expect(pointPart).toContain('& 8u')          // is_flat bit
    expect(pointPart).toContain('& 1u')          // fill
    expect(pointPart).toContain('& 2u')          // stroke
    expect(pointPart).toContain('& 4u')          // glow
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
  it('vs_point flat display branches: Mercator (< 0.5) + non-Mercator (< 6.5)', () => {
    // projection-display-layer-restore: flat Mercator (proj_params.x < 0.5)
    // recenters the PRECISE absolute Mercator DSFUN tail (slots 20-23) against
    // the camera — `(mx_h − cam_merc_h.x) + (mx_l − cam_merc_l.x)` — instead of
    // reprojecting the lossy f32 abs_lon/abs_lat. The other flat projTypes
    // (< 6.5) still use the shared flat_rel helper; the 3D ECEF anchor stays
    // in the else.
    const vsBody = pointPart.slice(pointPart.indexOf('fn vs_point'))
    const vsOnly = vsBody.slice(0, vsBody.indexOf('fn fs_point'))
    expect(vsOnly).toContain('u.proj_params.x < 0.5')
    expect(vsOnly).toContain('u.proj_params.x < 6.5')
    // The hand `let mx_h` / `let abs_lon` bindings were dropped, so the precise-
    // Mercator-tail read and the flat_rel arg are now inlined / cse-temp'd. Prove
    // the SAME properties via stable tokens: the Merc branch reads feat_data slot
    // 20 (the precise Mercator DSFUN high — not the lossy lon/lat reproject), and
    // the non-Mercator branch calls the shared flat_rel helper.
    expect(vsOnly).toMatch(/feat_data\[\([^\]]+ \+ 20u\)\]/)           // Mercator: precise DSFUN tail (slot 20)
    expect(vsOnly).not.toMatch(/project\(\w+, \w+, u\.proj_params\)/)  // not the lossy abs-lon/lat reproject
    expect(vsOnly).toMatch(/flat_rel\([\s\S]*?u\.proj_params/)         // non-Mercator (shared helper)
  })

  it('SDF helpers + switch on segment kind', () => {
    expect(pointPart).toContain('fn dist_to_line')
    expect(pointPart).toContain('fn dist_to_quadratic')
    expect(pointPart).toContain('fn dist_to_cubic')
    expect(pointPart).toContain('fn winding_line')
    expect(pointPart).toContain('fn sdf_shape')
    // The hand `let seg = segments[i]` binding was dropped; `seg.kind` is now the
    // inlined `segments[i].kind` (or a cse temp). Match the switch on the segment's
    // .kind field regardless of how the segment ref is spelled.
    expect(pointPart).toMatch(/switch \w+(\[\w+\])?\.kind/)
  })
  it('is structurally balanced (point module portion)', () => {
    expect((pointPart.match(/{/g) ?? []).length).toBe((pointPart.match(/}/g) ?? []).length)
    expect((pointPart.match(/\(/g) ?? []).length).toBe((pointPart.match(/\)/g) ?? []).length)
  })

  it('flat-branch uv assignment scales by expand/max(radiusPx,1) — same contract as billboard branch', () => {
    // BUG: flat branch used to emit `out.uv = off_xy` (bare ±1 corners),
    // making length(uv)==1 land at radiusPx+2 px instead of radiusPx px.
    // Both branches must divide by max(radiusPx,1) so the fragment-shader
    // `length(uv)==1` edge maps to exactly radiusPx px in both modes.
    //
    // We gate on the VS body only (before fs_point) to avoid false positives
    // from the fragment or helper functions.
    const vsBody = pointPart.slice(pointPart.indexOf('fn vs_point'))
    const vsOnly = vsBody.slice(0, vsBody.indexOf('fn fs_point'))

    // The flat branch must NOT assign the bare offset without scaling.
    // The CSE pass may hoist the sub-expression, so we check that a raw
    // uv = <var> (no multiply/divide) assignment does NOT appear.
    // (The CSE optimizer renames offXY to _cse* / _v* temps; we match
    //  the general pattern of "uv = <single-token>" with no operator.)
    expect(vsOnly).not.toMatch(/\.uv\s*=\s*[_a-zA-Z]\w*\s*;/)

    // Both the flat and billboard paths must emit a division by max(..., 1.0)
    // when writing .uv. The CSE optimizer emits `1.0` (not `1` / `1u` / `1f`).
    // Each branch emits its own assignment so there must be at least 2
    // occurrences of the uv-scaling division in the VS body.
    const uvLines = vsOnly.split('\n').filter(l => /\.uv\s*=/.test(l))
    expect(uvLines.length).toBeGreaterThanOrEqual(2)
    for (const line of uvLines) {
      // Every uv assignment must divide by max(..., 1.0) — no bare assignment.
      expect(line).toMatch(/\/\s*max\(/)
    }
  })
})
