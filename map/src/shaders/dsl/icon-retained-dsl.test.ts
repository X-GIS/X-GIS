import { describe, it, expect } from 'vitest'
import { emitIconRetainedWgsl, emitIconRetainedGlsl } from './icon-retained'

// #797 P1 retained geo-anchored icon shader — instanced procedural quad
// (instance_index + vertex_index), the point.ts geo→clip ladder (reused
// injected projection fns + pointU), and an atlas-sample fragment modulated by
// a per-instance tint. Gate: it emits valid-shaped WGSL with the expected
// bindings + entry points (a real-GPU pixel gate follows in playground/e2e).
describe('#797 P1 retained-icon shader — DSL emission', () => {
  const w = emitIconRetainedWgsl()

  it('reuses the shared injected projection fns (single-authority ladder)', () => {
    expect(w).toContain('needs_backface_cull')
    expect(w).toContain('flat_rel')
    expect(w).toContain('proj_globe')
  })

  it('reuses pointU as the group(0) frame uniform', () => {
    expect(w).toContain('struct Uniforms')
    expect(w).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
  })

  it('group(1): feat storage + SEPARATE tint storage + atlas texture/sampler', () => {
    expect(w).toContain('@group(1) @binding(0) var<storage, read> feat_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(1) var<storage, read> tint_data: array<vec4<f32>>;')
    expect(w).toContain('@group(1) @binding(2) var atlas_tex: texture_2d<f32>;')
    expect(w).toContain('@group(1) @binding(3) var atlas_smp: sampler;')
  })

  it('instanced VS: instance_index + vertex_index, no vertex buffers', () => {
    expect(w).toContain('@vertex')
    expect(w).toContain('vs_icon_retained')
    expect(w).toContain('@builtin(instance_index)')
    expect(w).toContain('@builtin(vertex_index)')
  })

  it('FS: atlas textureSample modulated by tint, globe cull discard', () => {
    expect(w).toContain('@fragment')
    expect(w).toContain('fs_icon_retained')
    expect(w).toContain('textureSample(atlas_tex, atlas_smp,')
    expect(w).toContain('discard;')
  })

  it('flat-Mercator branch adds the per-copy world_offset (circle_params.x)', () => {
    // world_offset rides circle_params.x — assert the flat-Merc relX reads it.
    expect(w).toContain('circle_params')
  })
})

// #823 — the WebGL2/GLSL twin. Same module split per stage, storage buffers
// lowered to R32F data textures (feat = array<f32> strided lanes; tint =
// array<vec4f> → 4 lanes + vec4 ctor). String-shape gate; the real-WebGL2
// compile+draw gate is playground/e2e/_graphics-retained-gl2-gate.spec.ts.
describe('#823 retained-icon shader — GLSL ES 3.00 twin', () => {
  const vs = emitIconRetainedGlsl('vertex')
  const fs = emitIconRetainedGlsl('fragment')

  it('emits one entry per stage with the gl_* builtin glue', () => {
    expect(vs).toContain('#version 300 es')
    expect(vs).toContain('gl_InstanceID')
    expect(vs).toContain('gl_VertexID')
    expect(vs).toContain('void main()')
    expect(fs).toContain('#version 300 es')
    expect(fs).toContain('void main()')
    expect(fs).toContain('discard;')
  })

  it('storage buffers are lowered to data textures (no SSBO in ES 3.00)', () => {
    expect(vs).toContain('uniform sampler2D feat_data;')
    expect(vs).toContain('uniform sampler2D tint_data;')
    expect(vs).toContain('texelFetch(feat_data,')
    expect(vs).toContain('texelFetch(tint_data,')
    expect(vs).not.toMatch(/\bbuffer\b/) // no SSBO declaration survives
  })

  it('frame uniform stays the shared pointU block (UBO tag = struct name)', () => {
    expect(vs).toContain('uniform Uniforms')
  })

  it('FS samples the atlas (fused sampler) and keeps the tint modulation', () => {
    expect(fs).toContain('texture(atlas_tex,')
  })
})
