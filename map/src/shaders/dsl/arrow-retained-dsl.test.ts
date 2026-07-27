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

  // #1333 — the black outline stroke. A per-instance `stroke_units` varying (0 for every
  // existing caller = no outline) drives an analytic SDF stroke band INSIDE this shader —
  // not a second offset batch (a prior "bigger arrow underneath" attempt was reverted for
  // flaring unevenly around the arrowhead; see coverage-arrow-show.ts history).
  it('carries a flat-interpolated stroke_units varying (location 3)', () => {
    expect(w).toContain('@location(3) @interpolate(flat) stroke_units: f32')
  })

  it('composites the outline via mix(fill, black, strokeCov) — NOT mix by fill coverage', () => {
    // The specific formula matters: blending toward black by the FILL coverage (not a
    // stroke-only coverage) would darken every existing arrow's AA edge even at
    // stroke_units=0 — a regression caught and fixed before this shipped (see
    // arrow-retained-outline-math.test.ts for the algebraic proof). This asserts the
    // actual compiled WGSL uses `max(covTotal - covFill, 0)` as the mix factor, not covFill
    // directly, by checking the mix call's third argument is a max(...) expression.
    expect(w).toMatch(/mix\(in\.tint\.xyz, vec3<f32>\(0\.0, 0\.0, 0\.0\), max\(/)
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

  // #1333 — the outline varying + composite survive the GLSL twin unchanged.
  it('carries stroke_units across the vertex→fragment varying boundary', () => {
    expect(vs).toContain('flat out float stroke_units;')
    expect(fs).toContain('flat in float stroke_units;')
  })

  it('composites the outline via mix(fill, black, strokeCov) in GLSL too', () => {
    expect(fs).toMatch(/mix\(in_\.tint\.xyz, vec3\(0\.0, 0\.0, 0\.0\), max\(/)
  })
})
