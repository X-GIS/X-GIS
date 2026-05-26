// ═══════════════════════════════════════════════════════════════════
// Polygon DSL — emitPolygonWgsl smoke tests
// ═══════════════════════════════════════════════════════════════════
//
// Phase 2.5 US-007b SKELETON smoke coverage. The full 14 AC3 combination
// matrix lands in US-007c once the 3 vertex + 5 main fragment entries +
// the placeholder Stmt swap composer have been ported. This file pins the
// skeleton: null variant + bare emit produces valid WGSL structurally
// (balanced braces / parens, declarations present, no throw).

import { describe, expect, it } from 'vitest'
import { emitPolygonWgsl } from './polygon'

describe('emitPolygonWgsl — skeleton', () => {
  it('emits non-empty WGSL for null variant, pickEnabled=false', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl.length).toBeGreaterThan(0)
    // Sanity: prepended projection consts + log-depth fns + projection fns
    // are present (the polygon module body refers to needs_backface_cull /
    // rim_alpha / inv_merc_lat_rad / DEG2RAD / EARTH_R by name).
    expect(wgsl).toContain('DEG2RAD')
    expect(wgsl).toContain('EARTH_R')
    expect(wgsl).toContain('fn needs_backface_cull')
    expect(wgsl).toContain('fn rim_alpha')
    expect(wgsl).toContain('fn inv_merc_lat_rad')
  })

  it('emits the polygon base Uniforms struct + fixed bindings', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('struct Uniforms')
    expect(wgsl).toContain('mvp: mat4x4<f32>')
    expect(wgsl).toContain('fill_color: vec4<f32>')
    expect(wgsl).toContain('stroke_color: vec4<f32>')
    // Fixed bindings from POLYGON_SHADER_SOURCE.
    expect(wgsl).toMatch(/@group\(0\)\s*@binding\(0\).*u\s*:\s*Uniforms/)
    expect(wgsl).toMatch(/@group\(0\)\s*@binding\(5\).*sprite_atlas/)
    expect(wgsl).toMatch(/@group\(0\)\s*@binding\(6\).*sprite_samp/)
  })

  it('emits polygon helper fns (polygon_cos_c_fragment + polygon_rim_alpha)', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn polygon_cos_c_fragment')
    expect(wgsl).toContain('fn polygon_rim_alpha')
  })

  it('emits fs_overdraw fragment entry', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn fs_overdraw')
    expect(wgsl).toContain('@fragment')
  })

  it('emits vs_main_quantized vertex entry with unorm16-packed pos_raw attribute', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn vs_main_quantized')
    // pos_raw is the packed @location(0) vec2<u32>; feature_id stays at
    // location 2 (no @location(1) in the quantized path).
    expect(wgsl).toMatch(/@location\(0\)[^,]+pos_raw\s*:\s*vec2<u32>/)
    // 0x8000 is_top bit + 0x7FFF position-quanta mask — invariants the
    // upload-side mesh generator depends on. The WGSL backend emits u32
    // literals as decimal with `u` suffix (32768u / 32767u).
    expect(wgsl).toContain('32768u')
    expect(wgsl).toContain('32767u')
  })

  it('emits vs_main vertex entry with DSFUN-split pos_h + pos_l attributes', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn vs_main')
    expect(wgsl).toContain('@vertex')
    // Per-vertex attributes from POLYGON_SHADER_SOURCE.
    expect(wgsl).toMatch(/@location\(0\)[^,]+pos_h\s*:\s*vec2<f32>/)
    expect(wgsl).toMatch(/@location\(1\)[^,]+pos_l\s*:\s*vec2<f32>/)
    expect(wgsl).toMatch(/@location\(2\)[^,]+feature_id\s*:\s*f32/)
    // Sanity: vertex path emits the project_geom / project / proj_globe /
    // apply_log_depth call sites the post-MVP transform depends on.
    expect(wgsl).toContain('project_geom(')
    expect(wgsl).toContain('proj_globe(')
    expect(wgsl).toContain('apply_log_depth(')
  })

  it('pickEnabled=true adds the pick attachment field to FragmentOutput', () => {
    const wgslOff = emitPolygonWgsl(null, false)
    const wgslOn = emitPolygonWgsl(null, true)
    expect(wgslOff).not.toMatch(/struct FragmentOutput[\s\S]*pick\s*:\s*vec2<u32>/)
    expect(wgslOn).toMatch(/struct FragmentOutput[\s\S]*pick\s*:\s*vec2<u32>/)
    expect(wgslOn).toContain('@interpolate(flat)')
  })

  it('balanced braces + parens (structural validity)', () => {
    const wgsl = emitPolygonWgsl(null, false)
    const braces = { open: 0, close: 0 }
    const parens = { open: 0, close: 0 }
    for (const ch of wgsl) {
      if (ch === '{') braces.open++
      else if (ch === '}') braces.close++
      else if (ch === '(') parens.open++
      else if (ch === ')') parens.close++
    }
    expect(braces.open).toBe(braces.close)
    expect(parens.open).toBe(parens.close)
  })

  it('null variant produces identical output regardless of preamble null vs absent', () => {
    // Sanity smoke for the variant-merge no-op path. Once the placeholder
    // Stmt swap + preamble merge composer ports land in US-007c, the
    // 14-combination matrix takes over from this skeleton smoke.
    const wgslNull = emitPolygonWgsl(null, false)
    const wgslEmptyVariant = emitPolygonWgsl(
      {
        preamble: null,
        fillExpr: null,
        strokeExpr: null,
        fillPreamble: null,
        strokePreamble: null,
        needsFeatureBuffer: false,
      },
      false,
    )
    expect(wgslEmptyVariant).toBe(wgslNull)
  })
})
