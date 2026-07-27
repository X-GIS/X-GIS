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

  // #1333 — the arrow GLYPH drifts along its own bearing (the flow reads as moving, instead of
  // the symbol sitting pinned at its grid cell). Closed-form + stateless, so a pinned `t` stays
  // byte-reproducible and the GLSL twin is free.
  it('derives the drift phase from the animation clock + the per-instance seeds', () => {
    // phase = fract(t / max(lifetime_s, eps) + phase_norm), reading the stride-29 slots 27/28.
    expect(w).toMatch(
      /fract\(\(\(u\.circle_params\.y \/ max\(feat_data\[\(\(inst \* 29u\) \+ 27u\)\], 0\.001\)\) \+ feat_data\[\(\(inst \* 29u\) \+ 28u\)\]\)\)/,
    )
  })

  it('OFFSETS THE POSITION by phase × drift_px along the projected bearing', () => {
    // The load-bearing claim: slot 26 (drift_px) is read, multiplied by the phase, and the
    // result is added to the tail clip position — i.e. the glyph actually MOVES. Asserting the
    // varying exists would not prove this; asserting the product reaching the position does.
    const drift = /let (_cse\d+) = feat_data\[\(\(inst \* 29u\) \+ 26u\)\];/.exec(w)
    expect(drift, 'drift_px (slot 26) must be read').not.toBeNull()
    const phaseTimesDrift = new RegExp(`let (_cse\\d+) = \\(_cse\\d+ \\* ${drift![1]!}\\);`).exec(w)
    expect(phaseTimesDrift, 'drift_px must be scaled by the phase').not.toBeNull()
    // …and that product must feed a vec4 added onto the projected tail (the drifted centre).
    expect(w).toMatch(
      new RegExp(`\\(_cse\\d+ \\+ vec4<f32>\\(\\(vec2<f32>\\(\\(\\(${phaseTimesDrift![1]!} \\*`),
    )
  })

  it('carries a flat-interpolated life_alpha varying (location 4)', () => {
    expect(w).toContain('@location(4) @interpolate(flat) life_alpha: f32')
  })

  it('gates the life fade behind select — a PINNED arrow keeps alpha EXACTLY 1.0', () => {
    // The specific shape matters: applying the fade unconditionally would dip a NON-drifting
    // arrow's alpha below 1 for most of its phase, silently altering every existing `| arrow`
    // consumer. WGSL's select is (falseValue, trueValue, cond), so the literal 1.0 in the FIRST
    // slot is the pinned branch. Pinned to the life_alpha assignment specifically — a bare
    // /select\(.*1\.0.*\)/ would also match the projection helpers' select(-1.0, 1.0, …).
    expect(w).toMatch(/_v0\.life_alpha = select\(1\.0, \(smoothstep\(/)
  })

  it('multiplies life_alpha into the FS output alpha', () => {
    expect(w).toMatch(/\(\(in\.tint\.w \* _cse\d+\) \* in\.life_alpha\)/)
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

  // #1333 — the drift + life-fade survive the GLSL twin unchanged.
  it('carries the drift math + life_alpha varying across the twin', () => {
    expect(vs).toContain('fract(')
    expect(vs).toContain('flat out float life_alpha;')
    expect(fs).toContain('flat in float life_alpha;')
  })
})
