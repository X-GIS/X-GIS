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
import { f32, u32, vec4, vec4fT, f32T, matchExpr, Node } from '../core/ir'

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

  it('emits all 5 main fragment entries + fs_overdraw', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn fs_fill')
    expect(wgsl).toContain('fn fs_fill_pattern')
    expect(wgsl).toContain('fn fs_oit_translucent')
    expect(wgsl).toContain('fn fs_fill_extrude')
    expect(wgsl).toContain('fn fs_stroke')
    expect(wgsl).toContain('fn fs_overdraw')
  })

  it('composer substitutes default fill/stroke-return Stmts on null variant', () => {
    const wgsl = emitPolygonWgsl(null, false)
    // No bare placeholder comments leak past the composer in the standard
    // null-variant emit path (the placeholder Stmts in fs_fill / fs_stroke
    // bodies are swapped with the default-uniform assigns below).
    expect(wgsl).not.toContain('// __placeholder:')
    // Default fill-return: out.color = vec4(u.fill_color.rgb * wall_shade, u.fill_color.a)
    // Note: DSL `.a` normalizes to `.w` in WGSL emit (the single-component
    // accessor unifies r/g/b/a -> x/y/z/w; multi-letter swizzles like .rgb
    // pass through as-authored).
    expect(wgsl).toMatch(/out\.color\s*=\s*vec4<f32>\(\(u\.fill_color\.rgb\s*\*\s*wall_shade\),\s*u\.fill_color\.w\)/)
    // Default stroke-return: out.color = vec4(u.stroke_color.rgb, u.stroke_color.a * alpha_scale)
    expect(wgsl).toMatch(/out\.color\s*=\s*vec4<f32>\(u\.stroke_color\.rgb,\s*\(u\.stroke_color\.w\s*\*\s*alpha_scale\)\)/)
  })

  it('fs_fill_pattern samples sprite_atlas with world-anchored UV', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('textureSample(sprite_atlas')
    expect(wgsl).toContain('fract(')
    expect(wgsl).toContain('uv_local')
    expect(wgsl).toContain('atlas_uv')
  })

  it('fs_oit_translucent emits dual MRT (accum + revealage) with McGuire-Bavoil weight', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('struct OitFragmentOutput')
    expect(wgsl).toContain('accum')
    expect(wgsl).toContain('revealage')
    // McGuire-Bavoil 7.4 weight constants.
    expect(wgsl).toContain('0.03')
    expect(wgsl).toContain('200')
    expect(wgsl).toContain('pow(')
  })

  it('emits fs_fill fragment with placeholder Stmt + wall_shade + log-depth jitter', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn fs_fill')
    // Wall-shading (iter 129 final).
    expect(wgsl).toContain('v_shade')
    expect(wgsl).toContain('wall_shade')
    expect(wgsl).toContain('roof_bonus')
    // Null-variant composer substitutes the default-uniform fill-return
    // assign (legacy POLYGON_SHADER_SOURCE:565 line). No bare placeholder
    // comment leaks past the composer in the standard emit path.
    expect(wgsl).not.toContain('// __placeholder: fill-return')
    // Per-feature log-depth jitter (xor-shift mix on low 16 bits of feat_id).
    expect(wgsl).toContain('id_lo')
    expect(wgsl).toContain('mixed')
    expect(wgsl).toContain('jitter')
    // Mask + shift constants in the WGSL emit.
    expect(wgsl).toContain('65535u') // 0xFFFF
    expect(wgsl).toContain('1023u')  // 0x3FF
  })

  it('fs_fill pick attachment write is conditional on pickEnabled', () => {
    const wgslOff = emitPolygonWgsl(null, false)
    const wgslOn = emitPolygonWgsl(null, true)
    // pick write touches out.pick — only present when pickEnabled.
    expect(wgslOff).not.toContain('out.pick')
    expect(wgslOn).toContain('out.pick')
  })

  it('emits vs_main_ecef_extruded vertex entry with iter-194 per-vertex lighting', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn vs_main_ecef_extruded')
    // Phase 2 PR 2c.2: ECEF VS reads per-vertex face_normal (location 5),
    // wall_height (location 6), is_top (location 7) — replacing the
    // legacy vec4 z_attr packing.
    expect(wgsl).toMatch(/@location\(5\)[^,]+face_normal\s*:\s*vec3<f32>/)
    expect(wgsl).toMatch(/@location\(6\)[^,]+wall_height\s*:\s*f32/)
    expect(wgsl).toMatch(/@location\(7\)[^,]+is_top\s*:\s*f32/)
    // #420 — the MapLibre light (raw 0.288,-0.498,0.996) now lives in the
    // CPU pack (vector-tile-renderer), rotated into ECEF by the camera-anchor
    // ENU→ECEF basis so it shares the face_normal's frame. The shader reads
    // it from the uniform; the raw literals no longer appear in WGSL.
    expect(wgsl).toContain('u.light_dir_ecef')
    expect(wgsl).toMatch(/u\.light_dir_ecef\.xyz/)
    expect(wgsl).not.toContain('0.288')
    expect(wgsl).not.toContain('-0.498')
    // Luminance-weight rec.709 constants from MapLibre's source.
    expect(wgsl).toContain('0.2126')
    expect(wgsl).toContain('0.7152')
    expect(wgsl).toContain('0.0722')
  })

  it('emits vs_main_ecef vertex entry with PR 2f quantized-position ECEF attributes', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn vs_main_ecef')
    // Phase 2 PR 2f: position is quantized 32-bit fixed point per axis,
    // split into uint16x4 (loc 0 → vec4<u32>) + uint16x2 (loc 1 → vec2<u32>).
    // abs_lon/abs_lat stay f32 at locations 3/4.
    expect(wgsl).toMatch(/@location\(0\)[^,]+q_xy\s*:\s*vec4<u32>/)
    expect(wgsl).toMatch(/@location\(1\)[^,]+q_z\s*:\s*vec2<u32>/)
    expect(wgsl).toMatch(/@location\(3\)[^,]+abs_lon\s*:\s*f32/)
    expect(wgsl).toMatch(/@location\(4\)[^,]+abs_lat\s*:\s*f32/)
    // Dequant: q = f32(hi)*65536 + f32(lo); axis = q*scale - half.
    expect(wgsl).toContain('65536')
    expect(wgsl).toContain('u.tile_dequant_scale')
    expect(wgsl).toContain('u.tile_dequant_half')
    // Linear ECEF MVP transform: u.mvp * vec4(ecef_rtc, 1.0).
    expect(wgsl).toContain('u.mvp')
    expect(wgsl).toContain('ecef_rtc')
  })

  it('emits vs_main vertex entry with stride-9 ECEF DSFUN attributes (post PR 2d.1D)', () => {
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('fn vs_main')
    expect(wgsl).toContain('@vertex')
    // Per-vertex attributes — post PR 2d.1D this is stride-9 ECEF DSFUN
    // matching vs_main_ecef's flat-fill layout. pos_h/pos_l promoted
    // vec2→vec3 (added z); abs_lon/abs_lat appended for fragment-side
    // hemisphere-cull recompute.
    expect(wgsl).toMatch(/@location\(0\)[^,]+pos_h\s*:\s*vec3<f32>/)
    expect(wgsl).toMatch(/@location\(1\)[^,]+pos_l\s*:\s*vec3<f32>/)
    expect(wgsl).toMatch(/@location\(2\)[^,]+feature_id\s*:\s*f32/)
    // vs_main now consumes u.mvp (ECEF-MVP) directly — legacy
    // project_geom / proj_globe calls retired. apply_log_depth is still
    // used for the depth-buffer linearisation common to all VS entries.
    expect(wgsl).toContain('apply_log_depth(')
  })

  it('vs entries gain flat display branches: Mercator (< 0.5) + non-Mercator (< 6.5)', () => {
    // projection-display-layer-restore Phase 2: flat Mercator (proj_params.x
    // < 0.5) reprojects via project() − tile_origin − cam_h − cam_l; the other
    // flat projTypes (< 6.5) via the shared flat_rel helper (project_geom −
    // projected camera centre). 3D / globe keeps the ECEF-RTC else path.
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('project(abs_lon, abs_lat, u.proj_params)')          // Mercator
    expect(wgsl).toContain('flat_rel(abs_lon, abs_lat, u.proj_params')          // non-Mercator (shared helper)
    expect(wgsl).toContain('fn flat_rel(')                                       // emitted once, shared by all
    expect(wgsl).toContain('u.proj_params.x < 0.5')
    expect(wgsl).toContain('u.proj_params.x < 6.5')
    // fill (vs_main_ecef) + line-entry (vs_main) + extruded all carry both.
    expect((wgsl.match(/u\.proj_params\.x < 0\.5/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((wgsl.match(/u\.proj_params\.x < 6\.5/g) ?? []).length).toBeGreaterThanOrEqual(3)
    // ECEF 3D path preserved in the final else branch.
    expect(wgsl).toContain('cam_ecef_off_h')
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

  it('variant.fillExpr replaces the fill-return placeholder with the variant Expr', () => {
    // Build a trivial variant whose fillExpr is a vec4 of constants —
    // emulates a constant-color data-driven path (US-005 idiom #1).
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: null,
      fillExpr: vec4(f32(0.1), f32(0.2), f32(0.3), f32(0.4)),
      strokeExpr: null,
      fillPreamble: null,
      strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    // Variant expr substituted into the fill-return assign.
    expect(wgsl).toMatch(/out\.color\s*=\s*vec4<f32>\(0\.1,\s*0\.2,\s*0\.3,\s*0\.4\)/)
    // Variant assign is fs_fill's only out.color line — the default-uniform
    // path 'u.fill_color.rgb * wall_shade' still appears in fs_oit_translucent
    // (whose OIT-path is independent of the variant swap), so we can't blanket-
    // forbid the substring across the full WGSL.
  })

  it('variant.fillPreamble Stmts are emitted before the variant fill-return assign', () => {
    // fillPreamble carries the `var _mcSS = ...; if (...) { _mcSS = ...; }`
    // shape the categorical-encoder lays down. Smoke test via a tiny
    // var-declaration Stmt + a varref Expr that the assign references.
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: null,
      fillExpr: new Node<'vec4<f32>'>({ op: 'varref', type: vec4fT, name: '_mcSS' }),
      strokeExpr: null,
      fillPreamble: [
        { s: 'var', name: '_mcSS', type: vec4fT, init: vec4(f32(0.5), f32(0.5), f32(0.5), f32(1)).expr },
      ],
      strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    // Preamble var emitted...
    expect(wgsl).toContain('var _mcSS: vec4<f32> = vec4<f32>(0.5, 0.5, 0.5, 1.0)')
    // ...then the variant fill-return assigns _mcSS into out.color.
    expect(wgsl).toMatch(/out\.color\s*=\s*_mcSS/)
  })

  it('raw-WGSL fillPreamble Stmt is emitted verbatim at body indent before the assign (PR 2e.B.2)', () => {
    // The renderer wraps the compiler's match-chain preamble STRING in a raw
    // Stmt; the composer must emit it verbatim (first line at the 2-space body
    // indent) immediately before the fill-return assign — byte-identical to
    // the retired post-emit string splice.
    const rawChain = 'var _mcSS: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);\n  if (input.feat_id == 0u) { _mcSS = vec4f(1.0, 0.0, 0.0, 1.0); }\n'
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: null,
      fillExpr: new Node<'vec4<f32>'>({ op: 'varref', type: vec4fT, name: '_mcSS' }),
      strokeExpr: null,
      fillPreamble: [{ s: 'raw', wgsl: rawChain }],
      strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    // The raw chain lands with its first line at the 2-space body indent,
    // directly followed (after the chain's own trailing newline) by the assign.
    expect(wgsl).toContain('  ' + rawChain + '\n  out.color = _mcSS;')
  })

  it('variant.needsFeatureBuffer appends the feat_data @group(1) @binding(0) storage binding', () => {
    const wgslOff = emitPolygonWgsl(null, false)
    expect(wgslOff).not.toContain('feat_data')
    const wgslOn = emitPolygonWgsl(
      {
        preamble: null,
        fillExpr: null,
        strokeExpr: null,
        fillPreamble: null,
        strokePreamble: null,
        needsFeatureBuffer: true,
      },
      false,
    )
    // feat_data lives in @group(0) @binding(1) per the renderer's bind-
    // group convention (group 0 = per-tile uniforms + texture/sampler +
    // feat_data storage; group 1 = palette atlas; group 2 = compute out).
    expect(wgslOn).toMatch(/@group\(0\)\s*@binding\(1\).*feat_data\s*:\s*array<f32>/)
  })

  it('AC3 #3 — variant.preamble.consts only → consts appended; fill/stroke unchanged', () => {
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: {
        consts: [{ name: 'CUSTOM_K', type: vec4fT, wgslValue: 0, cpuValue: 0 }],
      },
      fillExpr: null, strokeExpr: null,
      fillPreamble: null, strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    expect(wgsl).toContain('CUSTOM_K')
    // Default fill/stroke return still in place.
    expect(wgsl).toMatch(/out\.color\s*=\s*vec4<f32>\(\(u\.fill_color\.rgb/)
  })

  it('AC3 #4 — variant.preamble.bindings only → binding appended at requested group/binding', () => {
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: {
        bindings: [{ group: 3, binding: 7, name: 'custom_buf', space: 'storage', access: 'read', type: vec4fT }],
      },
      fillExpr: null, strokeExpr: null,
      fillPreamble: null, strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    expect(wgsl).toMatch(/@group\(3\)\s*@binding\(7\)/)
    expect(wgsl).toContain('custom_buf')
  })

  it('AC3 #5 — variant.preamble.funcs only → helper fn appended', () => {
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: {
        funcs: [{
          name: 'custom_helper',
          params: [],
          ret: f32T,
          body: [{ s: 'return', expr: f32(42).expr }],
        }],
      },
      fillExpr: null, strokeExpr: null,
      fillPreamble: null, strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    expect(wgsl).toContain('fn custom_helper')
  })

  it('AC3 #8 — both fillExpr AND strokeExpr together replace both placeholders', () => {
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: null,
      fillExpr: vec4(f32(0.1), f32(0.2), f32(0.3), f32(0.4)),
      strokeExpr: vec4(f32(0.5), f32(0.6), f32(0.7), f32(0.8)),
      fillPreamble: null, strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    expect(wgsl).toMatch(/out\.color\s*=\s*vec4<f32>\(0\.1,\s*0\.2,\s*0\.3,\s*0\.4\)/)
    expect(wgsl).toMatch(/out\.color\s*=\s*vec4<f32>\(0\.5,\s*0\.6,\s*0\.7,\s*0\.8\)/)
  })

  it('AC3 #9 — fillPreamble alone without fillExpr is a no-op (composer falls back to default)', () => {
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: null,
      fillExpr: null, strokeExpr: null,
      // Preamble Stmts authored but no fill-return Expr — composer ignores
      // the preamble and emits the default-uniform fill path. This pins
      // AC3's "preamble paired with expr" contract.
      fillPreamble: [{ s: 'var', name: '_mcSS', type: vec4fT, init: vec4(f32(0), f32(0), f32(0), f32(1)).expr }],
      strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    // Default fill-return still emitted.
    expect(wgsl).toMatch(/out\.color\s*=\s*vec4<f32>\(\(u\.fill_color\.rgb\s*\*\s*wall_shade\)/)
    // The orphan preamble does NOT leak into fs_fill.
    expect(wgsl).not.toContain('var _mcSS')
  })

  it('AC3 #11 — matchExpr Node as fillExpr → lowerModule hoists slot + Stmt.switch', () => {
    // Variant carries a matchExpr Node as its fillExpr. The wgsl-lower
    // pre-emit pass hoists the matchExpr into a `var _mr_N: vec4<f32>` slot
    // + Stmt.switch BEFORE the placeholder swap's assign (per AC2's
    // Stmt.switch lowering rule). The fs_fill body emits BOTH the
    // hoisted var-and-switch AND the final assign.
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: null,
      fillExpr: matchExpr(
        u32(0),
        [[0, vec4(f32(1), f32(0), f32(0), f32(1))], [1, vec4(f32(0), f32(1), f32(0), f32(1))]],
        vec4(f32(0), f32(0), f32(1), f32(1)),
      ),
      strokeExpr: null,
      fillPreamble: null, strokePreamble: null,
      needsFeatureBuffer: false,
    }
    const wgsl = emitPolygonWgsl(variant, false)
    // Hoisted slot from wgsl-lower.
    expect(wgsl).toMatch(/var _mr_\d+\s*:\s*vec4<f32>/)
    // Stmt.switch on the matchExpr scrutinee (DSL emits `switch <expr> {`
    // without WGSL's expected parens — naga/tint accept both forms).
    expect(wgsl).toMatch(/switch\s+/)
    expect(wgsl).toContain('case 0')
    // Final assign references the slot.
    expect(wgsl).toMatch(/out\.color\s*=\s*_mr_\d+/)
  })

  it('AC3 #13 — pick + fillExpr + feat_data full-stack composition', () => {
    const variant: import('./polygon').ShaderVariantInfo = {
      preamble: null,
      fillExpr: vec4(f32(0.5), f32(0.5), f32(0.5), f32(1)),
      strokeExpr: null,
      fillPreamble: null, strokePreamble: null,
      needsFeatureBuffer: true,
    }
    const wgsl = emitPolygonWgsl(variant, true) // pickEnabled
    // All three composition axes appear in the output.
    expect(wgsl).toContain('out.pick')               // pick attachment write
    expect(wgsl).toMatch(/out\.color\s*=\s*vec4<f32>\(0\.5,\s*0\.5/)  // variant fillExpr
    expect(wgsl).toMatch(/@group\(0\)\s*@binding\(1\).*feat_data/)    // feat_data binding
  })

  it('variant.computeBindings appends storage bindings for each compute output buffer', () => {
    const wgslOn = emitPolygonWgsl(
      {
        preamble: null,
        fillExpr: null,
        strokeExpr: null,
        fillPreamble: null,
        strokePreamble: null,
        needsFeatureBuffer: false,
        computeBindings: [
          { bindGroup: 2, binding: 0, bufferName: 'compute_out_fill', paintAxis: 'fill' },
          { bindGroup: 2, binding: 1, bufferName: 'compute_out_stroke', paintAxis: 'stroke' },
        ],
      },
      false,
    )
    expect(wgslOn).toMatch(/@group\(2\)\s*@binding\(0\).*compute_out_fill\s*:\s*array<u32>/)
    expect(wgslOn).toMatch(/@group\(2\)\s*@binding\(1\).*compute_out_stroke\s*:\s*array<u32>/)
  })
})
