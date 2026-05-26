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
  const noPick = emitLineWgsl(false)
  const pick = emitLineWgsl(true)
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
    // Both fs_line + fs_line_pattern emit the pick write (fs_line_max returns
    // a bare vec4, no pick attachment).
    const writes = (pick.match(/out\.pick = vec2<u32>\(0u, 0u\);/g) ?? []).length
    expect(writes).toBe(2)
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
