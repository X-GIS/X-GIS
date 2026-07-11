import { describe, it, expect } from 'vitest'
import { emitCircleRetainedWgsl, emitCircleRetainedGlsl } from './circle-retained'

// #797 retained geo-anchored CIRCLE shader — instanced procedural bounding square
// (instance_index + vertex_index), the point.ts geo→clip ladder (reused injected
// projection fns + pointU), and an analytic disc-SDF (fill + inset stroke) coverage
// fragment. Gate: it emits valid-shaped WGSL with the expected bindings + entry
// points (the real-GPU pixel gate is playground/e2e/_graphics-retained-circle-*.spec).
describe('#797 retained-circle shader — DSL emission', () => {
  const w = emitCircleRetainedWgsl()

  it('reuses the shared injected projection fns (single-authority ladder)', () => {
    expect(w).toContain('needs_backface_cull')
    expect(w).toContain('flat_rel')
    expect(w).toContain('proj_globe')
  })

  it('reuses pointU as the group(0) frame uniform', () => {
    expect(w).toContain('struct Uniforms')
    expect(w).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
  })

  it('group(1): feat storage + SEPARATE fill-tint storage, NO atlas texture (procedural)', () => {
    expect(w).toContain('@group(1) @binding(0) var<storage, read> feat_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(1) var<storage, read> tint_data: array<vec4<f32>>;')
    // Discs have no sprite — the silhouette is an analytic SDF, so no atlas sampler.
    expect(w).not.toContain('atlas_tex')
  })

  it('instanced VS: instance_index + vertex_index, no vertex buffers', () => {
    expect(w).toContain('@vertex')
    expect(w).toContain('vs_circle_retained')
    expect(w).toContain('@builtin(instance_index)')
    expect(w).toContain('@builtin(vertex_index)')
  })

  it('FS: disc SDF (smoothstep coverage) with fwidth AA, globe cull discard', () => {
    expect(w).toContain('@fragment')
    expect(w).toContain('fs_circle_retained')
    expect(w).toContain('fwidth')
    expect(w).toContain('smoothstep')
    expect(w).toContain('discard;')
  })
})

// #823-ready — the WebGL2/GLSL twin. Same module split per stage, storage buffers
// lowered to R32F data textures. String-shape gate; the real-WebGL2 compile+draw gate
// is a follow-up playground/e2e spec.
describe('#797 retained-circle shader — GLSL ES 3.00 twin', () => {
  const vs = emitCircleRetainedGlsl('vertex')
  const fs = emitCircleRetainedGlsl('fragment')

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
    expect(vs).not.toMatch(/\bbuffer\b/) // no SSBO declaration survives
  })

  it('frame uniform stays the shared pointU block (UBO tag = struct name)', () => {
    expect(vs).toContain('uniform Uniforms')
  })
})
