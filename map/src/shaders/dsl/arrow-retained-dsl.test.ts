import { describe, it, expect } from 'vitest'
import { emitArrowRetainedWgsl, emitArrowRetainedGlsl } from './arrow-retained'

// #824/#825 retained geo-anchored ARROW shader — instanced procedural bounding
// quad (instance_index + vertex_index), the point.ts geo→clip ladder (reused
// injected projection fns + pointU), the direction derived by projecting TWO geo
// points (tail + tip), and an analytic-SDF coverage fragment. Gate: it emits
// valid-shaped WGSL with the expected bindings + entry points (the real-GPU pixel
// gate is playground/e2e/_graphics-retained-arrow-*.spec).
describe('#824/#825 retained-arrow shader — DSL emission', () => {
  const w = emitArrowRetainedWgsl()

  it('reuses the shared injected projection fns (single-authority ladder)', () => {
    expect(w).toContain('needs_backface_cull')
    expect(w).toContain('flat_rel')
    expect(w).toContain('proj_globe')
  })

  it('reuses pointU as the group(0) frame uniform', () => {
    expect(w).toContain('struct Uniforms')
    expect(w).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
  })

  it('group(1): feat storage + SEPARATE tint storage, NO atlas texture (procedural)', () => {
    expect(w).toContain('@group(1) @binding(0) var<storage, read> feat_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(1) var<storage, read> tint_data: array<vec4<f32>>;')
    // Arrows have no sprite — the silhouette is an analytic SDF, so no atlas sampler.
    expect(w).not.toContain('atlas_tex')
  })

  it('instanced VS: instance_index + vertex_index, no vertex buffers', () => {
    expect(w).toContain('@vertex')
    expect(w).toContain('vs_arrow_retained')
    expect(w).toContain('@builtin(instance_index)')
    expect(w).toContain('@builtin(vertex_index)')
  })

  it('reads the frame viewport in the VS (aspect-correct screen orientation #825)', () => {
    // The screen direction derives from two projected points; the raw NDC delta is
    // per-axis normalized (aspect-skewed), so the VS scales it by u.viewport before
    // normalizing — the same viewport also drives the px→NDC quad offset.
    expect(w).toContain('u.viewport')
  })

  it('FS: analytic-SDF coverage with fwidth AA, globe cull discard', () => {
    expect(w).toContain('@fragment')
    expect(w).toContain('fs_arrow_retained')
    expect(w).toContain('fwidth')
    expect(w).toContain('discard;')
  })
})

// #823 — the WebGL2/GLSL twin. Same module split per stage, storage buffers
// lowered to R32F data textures (feat = array<f32> strided lanes; tint =
// array<vec4f>). String-shape gate; the real-WebGL2 compile+draw gate is
// playground/e2e/_graphics-retained-arrow-gl2-gate.spec.ts.
describe('#823 retained-arrow shader — GLSL ES 3.00 twin', () => {
  const vs = emitArrowRetainedGlsl('vertex')
  const fs = emitArrowRetainedGlsl('fragment')

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
})
