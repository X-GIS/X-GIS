import { describe, it, expect } from 'vitest'
import { emitLineWgsl, emitCompositeWgsl } from './line'

// Phase-2 line (SDF stroke) shader — the biggest production shader in the
// codebase (1314 LOC straight WGSL). Three fragment entry points share one
// compute_line_color helper; the pick attachment is a build-time variant
// (replaces the old __PICK_FIELD__ / __PICK_WRITE__ regex markers).
// Not cpu-evaluated (storage + many extern fn calls + bitcast/unpack — the
// CPU interp would need to model RGBA8 packing). The gate is the emission
// shape + the GPU pixel survey + the standalone CI render-gate.
describe('Phase-2 line shader — DSL emission', () => {
  // Structural contracts assert the AUTHORED shape -> emit at O1 (production is O2,
  // which inlines single-call prelude helpers + tree-shakes unused ones).
  const noPick = emitLineWgsl(false, 'O1')
  const pick = emitLineWgsl(true, 'O1')
  const linePart = (w: string) => w.slice(w.indexOf('struct TileUniforms'))

  it('prepends the shared projection + log-depth + SDF helper WGSL', () => {
    expect(noPick).toContain('proj_globe')
    expect(noPick).toContain('inv_merc_lat_rad')
    expect(noPick).toContain('needs_backface_cull')
    expect(noPick).toContain('fn rim_alpha')
    expect(noPick).toContain('fn apply_log_depth')
    expect(noPick).toContain('fn compute_log_frag_depth')
    expect(noPick).toContain('fn dist_to_segment')
    expect(noPick).toContain('fn dist_to_quadratic')
    expect(noPick).toContain('fn dist_to_cubic')
    expect(noPick).toContain('fn winding_line')
    // ECEF prepend (mirrors raster-dsl.test): the line VS calls the shared
    // lonlat_to_ecef primitive, so its definition + the WGS84 const must be
    // prepended. Guards against a future dropped/doubled ECEF prepend in line.ts.
    expect(noPick).toContain('fn lonlat_to_ecef(')
    expect(noPick).toContain('WGS84_A')
  })
  it('couples the fill viewport fill-translate onto polygon outlines (slots 46/47)', () => {
    // A fill's outline draws through the LINE pipeline but shares the fill's
    // per-tile uniform slot (strokeQueue reuses the fill slotOffset), so slots
    // 46/47 (`_pad_tail0.zw`) already carry the fill's (px*2/canvasDim) NDC
    // translate. The line VS must apply the SAME viewport offset the polygon VS
    // does (polygon.ts:345-346) or a translated fill's outline separates from
    // it — OFM building-top (fill-translate [-2,-2] + fill-outline-color)
    // rendered a visible DOUBLE edge at deep zoom (fill moved −2 px, outline 0).
    // Standalone line layers write 0 here → no-op; the squared-magnitude < 0.25
    // guard skips the pattern-repeat-METRES overload of these same slots.
    for (const w of [noPick, pick]) {
      // The fill-translate value is `tile._pad_tail0` (slots 46/47 carry it in
      // `.zw`). The cse/inline migration dropped the hand `let fill_translate_ndc`
      // binding, so the value now appears either inlined as `tile._pad_tail0` or
      // via a `_cseN` temp — match the slot field plus the stable clip transform.
      expect(w).toContain('tile._pad_tail0')
      // clip.x += translate.z * clip.w  (clip is now an auto-var `_avN`, translate a `_cseN`/`tile._pad_tail0`)
      expect(w).toMatch(/(\w+)\.x = \(\1\.x \+ \([\w.]+\.z \* \1\.w\)\)/)
      // clip.y -= translate.w * clip.w
      expect(w).toMatch(/(\w+)\.y = \(\1\.y - \([\w.]+\.w \* \1\.w\)\)/)
      expect(w).toContain('< 0.25')  // NDC≪0.5 applied; pattern-repeat metres≫0.5 skipped
      // applied to `clip` BEFORE log-depth finalises the position: the fill-translate
      // clip mutation precedes apply_log_depth in the VS body. (Anchor on the
      // `clip.x = (clip.x + ...)` mutation, not the struct field decl, so the
      // ordering is the real before/after — not trivially true.)
      expect(linePart(w)).toMatch(/(\w+)\.x = \(\1\.x \+ \([\w.]+\.z \* \1\.w\)\)[\s\S]*?apply_log_depth/)
    }
  })
  it('globe arm lifts z_lift along the GEODETIC NORMAL, not the ECEF polar axis', () => {
    // z_lift must ride INTO lonlat_to_ecef as the geodetic height argument —
    // the same frame the CPU lonLatToECEF uses for the extruded polygon roof
    // ring. The pre-fix form added z_lift to the ECEF Z component AFTER
    // conversion, displacing extruded outlines h·cos(lat) north of (and
    // h·(1−sin lat) below) the fill roof edge on globe (~44 m / ~37 px at z16
    // for h=50 at Seoul) — the user-visible fill-vs-outline offset.
    for (const w of [noPick, pick]) {
      // final clip arm + both width-clamp draft corners take the height arg.
      // The cse/inline migration dropped the hand `let <name>_lon_rad/_lat_rad`
      // bindings, so the lon/lat args are now inlined exprs (or `_cseN` temps) —
      // pin the call + the HEIGHT arg ending in `z_lift_m`, which is what proves
      // z_lift rides INTO lonlat_to_ecef. The segment accessor may emit as
      // `seg.z_lift_m` or `segments[...].z_lift_m`, so match the trailing field.
      // (`[^\n]*?` stays within one emitted stmt line → cannot span calls.)
      // 3 lifted call sites (clamp_base, clamp_corner, final_corner):
      const liftedCalls = (w.match(/lonlat_to_ecef\([^\n]*?\.z_lift_m\)/g) ?? []).length
      expect(liftedCalls).toBeGreaterThanOrEqual(3)
      // the RTC anchor stays height-0 (polygon tile_ecef_center parity)
      expect(w).toMatch(/lonlat_to_ecef\([^\n]*?, 0\.0\)/)
      // the polar-axis post-add form must NOT come back
      expect(w).not.toContain('ecef_rtc_lifted')
      expect(w).not.toContain('base_rtc_lifted')
      expect(w).not.toContain('corner_rtc_lifted')
    }
  })
  it('binds g0 tile + sprite + g1 layer + 3 storage<read>', () => {
    expect(linePart(noPick)).toContain('@group(0) @binding(0) var<uniform> tile: TileUniforms;')
    expect(linePart(noPick)).toContain('@group(0) @binding(5) var sprite_atlas: texture_2d<f32>;')
    expect(linePart(noPick)).toContain('@group(0) @binding(6) var sprite_samp: sampler;')
    expect(linePart(noPick)).toContain('@group(1) @binding(0) var<uniform> layer: LineLayer;')
    expect(linePart(noPick)).toContain('@group(1) @binding(1) var<storage, read> segments: array<LineSegment>;')
    expect(linePart(noPick)).toContain('@group(1) @binding(2) var<storage, read> shapes: array<ShapeDesc>;')
    expect(linePart(noPick)).toContain('@group(1) @binding(3) var<storage, read> shape_segments: array<ShapeSegment>;')
  })
  it('emits vertex (instance_index + vertex_index) and 3 fragment entries', () => {
    expect(linePart(noPick)).toContain('@vertex')
    expect(linePart(noPick)).toContain('fn vs_line(@builtin(instance_index) seg_id: u32, @builtin(vertex_index) vi: u32) -> LineOut')
    expect(linePart(noPick)).toContain('@fragment')
    expect(linePart(noPick)).toContain('fn fs_line(input: LineOut) -> LineFragmentOutput')
    expect(linePart(noPick)).toContain('fn fs_line_pattern(input: LineOut) -> LineFragmentOutput')
    expect(linePart(noPick)).toContain('fn fs_line_max(input: LineOut) -> @location(0) vec4<f32>')
  })
  it('compute_line_color shared helper + line_rim_alpha + sdf_shape', () => {
    expect(linePart(noPick)).toContain('fn compute_line_color(input: LineOut) -> vec4<f32>')
    expect(linePart(noPick)).toContain('fn line_rim_alpha(input: LineOut) -> f32')
    expect(linePart(noPick)).toContain('fn sdf_shape(uv_in: vec2<f32>, shape_id: u32) -> f32')
    // The 3 fragments call the shared helper; the rim is composed on top.
    const calls = (noPick.match(/compute_line_color\(/g) ?? []).length
    expect(calls).toBeGreaterThanOrEqual(4) // 1 def + 3 calls (fs_line, fs_line_pattern, fs_line_max)
  })
  it('bitwise unpacking of layer.flags + bitcast/unpack for per-segment colour', () => {
    expect(linePart(noPick)).toContain('(layer.flags & 7u)')             // cap_type
    expect(linePart(noPick)).toContain('((layer.flags >> 3u) & 3u)')     // join_flags
    expect(linePart(noPick)).toContain('(layer.flags & 64u)')            // LINE_FLAG_HAS_PATTERN
    expect(linePart(noPick)).toContain('bitcast<u32>(')                  // color_packed → u32
    expect(linePart(noPick)).toContain('unpack4x8unorm(')                // u32 → RGBA8 vec4
  })
  it('switch on vertex_index + for-loop with continue', () => {
    expect(linePart(noPick)).toContain('switch vi {')
    expect(linePart(noPick)).toContain('case 5u: {')
    expect(linePart(noPick)).toContain('continue;')
  })
  it('pick variant toggles the pick field + write in both fragment entries', () => {
    expect(noPick).not.toContain('pick: vec2<u32>')
    expect(noPick).not.toContain('out.pick')
    expect(pick).toContain('@location(1) @interpolate(flat) pick: vec2<u32>,')
    // Both fs_line + fs_line_pattern carry the pick value — now a field in the
    // LineFragmentOutput(...) constructor (not an `out.pick =` write); fs_line_max
    // returns a bare vec4, no pick attachment.
    const writes = (pick.match(/vec2<u32>\(0u, 0u\)/g) ?? []).length
    expect(writes).toBe(2)
  })
  it('VS applies the camera-relative ECEF offset (line↔fill alignment)', () => {
    // Camera-relative RTC fix: line projected vertex−tileEcefCenter into the
    // camera-at-ENU-origin MVP (no cameraCenter translate), so strokes landed
    // offset from their fills. The VS now adds cam_ecef_off (DSFUN hi+lo) like
    // polygon, projecting vertex−cameraCenter. The fields must sit at the same
    // byte offsets as polygon's Uniforms (52/56) since the line + polygon
    // shaders SHARE VTR's group(0) tile uniform slot.
    const tu = noPick.match(/struct TileUniforms \{([\s\S]*?)\n\}/)![1]!
    expect(tu).toContain('cam_ecef_off_h')
    expect(tu).toContain('cam_ecef_off_l')
    // WGSL std140 offsets (f32 slots): cam_ecef_off_h at 52, _l at 56. #600
    // appended _pad_light_dir (mirrors polygon's light_dir_ecef @240) + globe_eye
    // @256 (slot 64), so the struct is 272 bytes — identical to polygon Uniforms
    // (UNIFORM_SIZE), which it MUST be (shared VTR group(0) buffer).
    const T: Record<string, [number, number]> = {
      'mat4x4<f32>': [64, 16], 'vec4<f32>': [16, 16], 'vec2<f32>': [8, 8], 'f32': [4, 4], 'u32': [4, 4],
    }
    let cur = 0, maxA = 1; const off: Record<string, number> = {}
    for (const raw of tu.split('\n')) {
      const fm = raw.replace(/\/\/.*$/, '').trim().match(/^(\w+)\s*:\s*([\w<>]+)\s*,?$/)
      if (!fm) continue
      const [s, a] = T[fm[2]!]!; cur = Math.ceil(cur / a) * a; off[fm[1]!] = cur / 4; cur += s; if (a > maxA) maxA = a
    }
    expect(off.cam_ecef_off_h).toBe(52)
    expect(off.cam_ecef_off_l).toBe(56)
    expect(off.globe_eye).toBe(64) // #600 — MUST equal polygon Uniforms.globe_eye (shared buffer)
    expect(Math.ceil(cur / maxA) * maxA).toBe(272)
    // The final clip transform feeds vertex+offset through the MVP.
    const vs = noPick.slice(noPick.indexOf('fn vs_line'), noPick.indexOf('fn fs_line'))
    expect(vs).toContain('tile.cam_ecef_off_h')
    expect(vs).toContain('tile.cam_ecef_off_l')
  })
  it('vs_line flat display branch via finalize_corner (projType 0-6)', () => {
    // projection-display-layer-restore Phase 2: the flat branch (proj_params.x
    // < 6.5) routes through finalize_corner — Mercator passes the already-
    // camera-relative cornerLocal through; the other flat projTypes reproject
    // via the shared flat_rel helper (project_geom − projected camera centre).
    // The 3D ECEF path (cam_ecef_off) stays in the else.
    expect(noPick).toContain('fn finalize_corner(')
    expect(noPick).toContain('fn flat_rel(') // finalize_corner delegates to the shared flat_rel
    const vs = noPick.slice(noPick.indexOf('fn vs_line'), noPick.indexOf('fn fs_line'))
    expect(vs).toContain('tile.proj_params.x < 6.5')
    expect(vs).toContain('finalize_corner(')
    expect(vs).toContain('tile.cam_ecef_off_h')
  })

  it('both variants are structurally balanced (line module portion)', () => {
    for (const w of [linePart(noPick), linePart(pick)]) {
      expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
      expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
    }
  })
})

describe('Phase-2 line compositor — DSL emission', () => {
  const w = emitCompositeWgsl()
  it('binds samp + src + cu + emits vs_full / fs_full', () => {
    expect(w).toContain('@group(0) @binding(0) var samp: sampler;')
    expect(w).toContain('@group(0) @binding(1) var src: texture_2d<f32>;')
    expect(w).toContain('@group(0) @binding(2) var<uniform> cu: CompUniform;')
    expect(w).toContain('fn vs_full(@builtin(vertex_index) vi: u32) -> VsFullOut')
    expect(w).toContain('fn fs_full(input: VsFullOut) -> @location(0) vec4<f32>')
  })
  it('is structurally balanced', () => {
    expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
    expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
  })
})
