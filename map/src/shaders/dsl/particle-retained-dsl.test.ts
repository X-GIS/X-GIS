import { describe, it, expect } from 'vitest'
import { emitParticleRetainedWgsl, emitParticleRetainedGlsl } from './particle-retained'

// #826 retained geo-anchored PARTICLE-FLOW shader — candidate (b), the VS-integrated STATELESS
// drift (design §3.2). An instanced procedural bounding square (instance_index + vertex_index), the
// point.ts geo→clip ladder (reused injected projection fns + pointU), the arrow's #825 TWO-POINT
// direction, a CLOSED-FORM phase drift from the animation clock, and an analytic disc-SDF fragment.
// Gate: it emits valid-shaped WGSL with the expected bindings + entry points + the drift markers
// (the real-GPU pinned-`t` pixel gate is orchestrator-pending, playground/e2e).
describe('#826 retained-particle-flow shader — DSL emission (WGSL)', () => {
  const w = emitParticleRetainedWgsl()

  it('reuses the shared injected projection fns (single-authority ladder)', () => {
    expect(w).toContain('needs_backface_cull')
    expect(w).toContain('flat_rel')
    expect(w).toContain('proj_globe')
  })

  it('reuses pointU as the group(0) frame uniform (no bloat — zero new uniform block)', () => {
    expect(w).toContain('struct Uniforms')
    expect(w).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
  })

  it('group(1): feat storage + SEPARATE tint storage, NO atlas texture (procedural disc)', () => {
    expect(w).toContain('@group(1) @binding(0) var<storage, read> feat_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(1) var<storage, read> tint_data: array<vec4<f32>>;')
    // A particle dot has no sprite — the silhouette is an analytic SDF, so no atlas sampler.
    expect(w).not.toContain('atlas_tex')
  })

  it('instanced VS: instance_index + vertex_index, no vertex buffers', () => {
    expect(w).toContain('@vertex')
    expect(w).toContain('vs_particle_retained')
    expect(w).toContain('@builtin(instance_index)')
    expect(w).toContain('@builtin(vertex_index)')
  })

  it('closed-form drift: reads the animation clock (circle_params) + a fract phase saw', () => {
    // The animation clock `t` rides the circle_params lane of the frame uniform (design §3.0), and
    // the loop-forever phase is a `fract` saw (design §3.2) — the two markers of candidate (b).
    expect(w).toContain('circle_params')
    expect(w).toContain('fract(')
  })

  it('FS: disc SDF (smoothstep coverage) with fwidth AA, globe cull discard', () => {
    expect(w).toContain('@fragment')
    expect(w).toContain('fs_particle_retained')
    expect(w).toContain('fwidth')
    expect(w).toContain('smoothstep')
    expect(w).toContain('discard;')
  })
})

// #823-ready — the WebGL2/GLSL twin. FREE by construction: candidate (b) is a pure dual-source DSL
// pipeline (design §3.2), so the twin comes from the SAME authored module, storage lowered to R32F
// data textures. String-shape gate; the real-WebGL2 compile+draw gate is orchestrator-pending.
describe('#826 retained-particle-flow shader — GLSL ES 3.00 twin', () => {
  const vs = emitParticleRetainedGlsl('vertex')
  const fs = emitParticleRetainedGlsl('fragment')

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

  it('the drift twin carries the same fract phase saw as the WGSL', () => {
    expect(vs).toContain('fract(')
  })
})
