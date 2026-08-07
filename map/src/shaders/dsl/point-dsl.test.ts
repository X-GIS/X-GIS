import { describe, it, expect } from 'vitest'
import { vec4, f32, Node, vec4fT } from '@xgis/shader-dsl'
import {
  emitPointWgsl,
  emitPointGlsl,
  emitPointGlslStages,
  buildPointModule,
  type PointVariantSpec,
} from './point'

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
    expect(pointPart).toContain(
      '@group(0) @binding(2) var<storage, read> shapes: array<ShapeDesc>;',
    )
    expect(pointPart).toContain(
      '@group(0) @binding(3) var<storage, read> segments: array<Segment>;',
    )
  })
  it('vertex inputs: center / quad_id / feat_id', () => {
    expect(pointPart).toContain('@vertex')
    expect(pointPart).toContain(
      'fn vs_point(@location(0) center: vec2<f32>, @location(1) quad_id: u32, @location(2) feat_id: f32) -> PointOut',
    )
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
    expect(pointPart).toMatch(/>> 4u\) & 15u/) // size_mode  (>> 4, mask 0xF)
    expect(pointPart).toMatch(/>> 8u\) & 3u/) // anchor_mode (>> 8, mask 3)
    expect(pointPart).toContain('& 8u') // is_flat bit
    expect(pointPart).toContain('& 1u') // fill
    expect(pointPart).toContain('& 2u') // stroke
    expect(pointPart).toContain('& 4u') // glow
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
    expect(vsOnly).toMatch(/feat_data\[\([^\]]+ \+ 20u\)\]/) // Mercator: precise DSFUN tail (slot 20)
    expect(vsOnly).not.toMatch(/project\(\w+, \w+, u\.proj_params\)/) // not the lossy abs-lon/lat reproject
    expect(vsOnly).toMatch(/flat_rel\([\s\S]*?u\.proj_params/) // non-Mercator (shared helper)
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
    const uvLines = vsOnly.split('\n').filter((l) => /\.uv\s*=/.test(l))
    expect(uvLines.length).toBeGreaterThanOrEqual(2)
    for (const line of uvLines) {
      // Every uv assignment must divide by max(..., 1.0) — no bare assignment.
      expect(line).toMatch(/\/\s*max\(/)
    }
  })
})

describe('PointVariantSpec composer (#1605 Phase 2)', () => {
  const fsBody = (variant: PointVariantSpec | null) => {
    const w = emitPointWgsl(variant)
    const start = w.indexOf('fn fs_point')
    return w.slice(start, w.indexOf('\nfn ', start + 1))
  }

  it('a null variant emits both default feat_data-read assigns, no placeholder residue', () => {
    const body = fsBody(null)
    expect(body).toMatch(/point_fill_color\s*=\s*vec4<f32>\(feat_data\[/)
    expect(body).toMatch(/point_stroke_color\s*=\s*vec4<f32>\(feat_data\[/)
    expect(body).not.toContain('__placeholder')
  })

  it('a fill-only variant swaps the fill axis; the stroke axis still reads feat_data', () => {
    const variant: PointVariantSpec = {
      preamble: null,
      fillExpr: vec4(f32(0.9), f32(0.8), f32(0.7), f32(1)),
      strokeExpr: null,
      fillPreamble: null,
      strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const body = fsBody(variant)
    expect(body).toMatch(/point_fill_color\s*=\s*vec4<f32>\(0\.9,\s*0\.8,\s*0\.7,\s*1\.0\)/)
    expect(body).toMatch(/point_stroke_color\s*=\s*vec4<f32>\(feat_data\[/)
  })

  it('a stroke-only variant swaps the stroke axis; the fill axis still reads feat_data', () => {
    const variant: PointVariantSpec = {
      preamble: null,
      fillExpr: null,
      strokeExpr: vec4(f32(0.1), f32(0.2), f32(0.3), f32(1)),
      fillPreamble: null,
      strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const body = fsBody(variant)
    expect(body).toMatch(/point_fill_color\s*=\s*vec4<f32>\(feat_data\[/)
    expect(body).toMatch(/point_stroke_color\s*=\s*vec4<f32>\(0\.1,\s*0\.2,\s*0\.3,\s*1\.0\)/)
  })

  it('a both-axes variant swaps fill and stroke independently, in the same body', () => {
    const variant: PointVariantSpec = {
      preamble: null,
      fillExpr: vec4(f32(0.9), f32(0.8), f32(0.7), f32(1)),
      strokeExpr: vec4(f32(0.1), f32(0.2), f32(0.3), f32(1)),
      fillPreamble: null,
      strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const body = fsBody(variant)
    expect(body).toMatch(/point_fill_color\s*=\s*vec4<f32>\(0\.9,\s*0\.8,\s*0\.7,\s*1\.0\)/)
    expect(body).toMatch(/point_stroke_color\s*=\s*vec4<f32>\(0\.1,\s*0\.2,\s*0\.3,\s*1\.0\)/)
    expect(body).not.toContain('feat_data[(_lc0 + 1u')
  })

  it('fillPreamble / strokePreamble Stmts are emitted ahead of their respective assigns', () => {
    const variant: PointVariantSpec = {
      preamble: null,
      fillExpr: new Node<'vec4<f32>'>({ op: 'varref', type: vec4fT, name: '_fill_tmp' }),
      strokeExpr: new Node<'vec4<f32>'>({ op: 'varref', type: vec4fT, name: '_stroke_tmp' }),
      fillPreamble: [
        {
          s: 'var',
          name: '_fill_tmp',
          type: vec4fT,
          init: vec4(f32(0.5), f32(0.5), f32(0.5), f32(1)).expr,
        },
      ],
      strokePreamble: [
        {
          s: 'var',
          name: '_stroke_tmp',
          type: vec4fT,
          init: vec4(f32(0.4), f32(0.4), f32(0.4), f32(1)).expr,
        },
      ],
      needsFeatureBuffer: false,
    }
    const body = fsBody(variant)
    expect(body).toContain('var _fill_tmp: vec4<f32> = vec4<f32>(0.5, 0.5, 0.5, 1.0)')
    expect(body).toMatch(/point_fill_color\s*=\s*_fill_tmp/)
    expect(body).toContain('var _stroke_tmp: vec4<f32> = vec4<f32>(0.4, 0.4, 0.4, 1.0)')
    expect(body).toMatch(/point_stroke_color\s*=\s*_stroke_tmp/)
  })

  it('buildPointModule throws on needsFeatureBuffer (not supported yet, #1605)', () => {
    const variant: PointVariantSpec = {
      preamble: null,
      fillExpr: vec4(f32(0), f32(0), f32(0), f32(1)),
      strokeExpr: null,
      fillPreamble: null,
      strokePreamble: null,
      needsFeatureBuffer: true,
    }
    expect(() => buildPointModule(variant)).toThrow(/needsFeatureBuffer/)
  })

  it('emitPointGlsl / emitPointGlslStages compose cleanly for both stages with variant: null', () => {
    // Regression guard mirroring line's mandatory line-glsl.ts fix — point's
    // emitPointGlsl already reused buildPointModule (verified against live
    // code before this change), so this pins that it keeps doing so once the
    // placeholders exist, rather than silently reverting to a fresh rebuild.
    for (const stage of ['vertex', 'fragment'] as const) {
      expect(emitPointGlsl(null, stage)).not.toContain('__placeholder')
    }
    const stages = emitPointGlslStages(null)
    expect(stages.vertex).not.toContain('__placeholder')
    expect(stages.fragment).not.toContain('__placeholder')
  })
})
