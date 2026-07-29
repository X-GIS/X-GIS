import { describe, it, expect } from 'vitest'
import {
  emitArrowRetainedWgsl,
  emitArrowRetainedGlsl,
  emitArrowRetainedAdvectedWgsl,
  emitArrowRetainedAdvectedGlsl,
} from './arrow-retained'
import { ARROW_DRIFT_UV, emitArrowAdvectWgsl } from './arrow-advect-step'

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

// #1419 — the ADVECTED variant: the catalogue glyph IS the particle. A SECOND MODULE rather
// than a second entry in the static one, because `module()` declares bindings at module level:
// adding the state/velocity/band resources to the static module would change the static
// shader's emitted text even though its VS body is untouched. The first describe below is the
// property that buys — the static emit is provably free of everything this feature added.
describe('#1419 advected-arrow shader — the static path is untouched', () => {
  const w = emitArrowRetainedWgsl()
  const vs = emitArrowRetainedGlsl('vertex')

  it('no advected resource, and no advected entry, reaches the static module', () => {
    for (const leak of [
      'state_tex',
      'origin_tex',
      'flow_u_tex',
      'flow_v_tex',
      'band_data',
      'decode_arrow_pos',
      'vs_arrow_retained_advected',
    ]) {
      expect(w, `${leak} must not appear in the static WGSL`).not.toContain(leak)
      expect(vs, `${leak} must not appear in the static GLSL`).not.toContain(leak)
    }
  })

  it('still binds exactly feat + tint at group(1)', () => {
    expect(w).toContain('@group(1) @binding(0) var<storage, read> feat_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(1) var<storage, read> tint_data: array<vec4<f32>>;')
    expect(w).not.toContain('@group(1) @binding(2)')
  })
})

describe('#1419 advected-arrow shader — DSL emission', () => {
  const w = emitArrowRetainedAdvectedWgsl()

  it('binds the state, the origins, the velocity pair and the band table — and NO tint', () => {
    expect(w).toContain('@group(1) @binding(0) var<storage, read> feat_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(1) var<storage, read> band_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(2) var state_tex: texture_2d<f32>;')
    expect(w).toContain('@group(1) @binding(3) var origin_tex: texture_2d<f32>;')
    expect(w).toContain('@group(1) @binding(4) var flow_u_tex: texture_2d<f32>;')
    expect(w).toContain('@group(1) @binding(5) var flow_v_tex: texture_2d<f32>;')
    // The colour is the band the arrow is standing in, so there is no launch colour to keep.
    expect(w).not.toContain('tint_data')
  })

  it('reads every texture with textureLoad — textureSample is illegal in a vertex stage', () => {
    expect(w).toContain('textureLoad(state_tex')
    expect(w).toContain('textureLoad(origin_tex')
    expect(w).toContain('textureLoad(flow_u_tex')
    expect(w).toContain('textureLoad(flow_v_tex')
    expect(w).not.toContain('textureSample')
    // …and therefore declares no sampler at all, which is also what keeps the WebGL2
    // sampler-follows-its-texture ordering rule out of the vertex stage.
    expect(w).not.toContain(': sampler')
  })

  it('projects THREE anchors — the origin and BOTH grid-step bases', () => {
    // Two would be the static path's tail→tip pair, and scaling a single basis moves an arrow
    // along a straight line: the closed-form drift #65 shipped and #70 reverted.
    expect(w.match(/project_geo\(/g) ?? []).toHaveLength(4) // 1 definition + 3 calls
    expect(w).toContain('vs_arrow_retained_advected')
  })

  it('scales the displacement by the SAME leash the advect step enforces', () => {
    // The anchors are packed one ARROW_DRIFT_UV away, so this division is what makes the
    // multiplier land in [-1, 1] — the range the linearization is valid over.
    expect(w).toContain(`/ ${ARROW_DRIFT_UV}`)
  })

  it('shares decode_arrow_pos with the advect step — ONE encoding, not a twin', () => {
    // A second copy of this expression is the failure arrow-advect-state.ts's header names:
    // arrows that advect correctly and are DRAWN somewhere else.
    const body = (src: string) =>
      src.slice(
        src.indexOf('fn decode_arrow_pos'),
        src.indexOf('}', src.indexOf('fn decode_arrow_pos')),
      )
    expect(body(w)).toBe(body(emitArrowAdvectWgsl()))
  })

  it('holds no catalogue threshold of its own — it indexes the uploaded band table', () => {
    // Nine bands, compared against band_data's own edges. A literal knot value here would be a
    // second authority for the catalogue rule (s111-portrayal.ts owns it).
    expect(w.match(/band_data\[/g)?.length ?? 0).toBeGreaterThanOrEqual(9)
    expect(w).not.toContain('13.0') // band 9's edge, if it had been inlined
  })

  it('emits a GLSL twin per stage, storage lowered to data textures', () => {
    const gvs = emitArrowRetainedAdvectedGlsl('vertex')
    const gfs = emitArrowRetainedAdvectedGlsl('fragment')
    expect(gvs).toContain('#version 300 es')
    expect(gvs).toContain('void main()')
    expect(gvs).toContain('uniform sampler2D feat_data;')
    expect(gvs).toContain('uniform sampler2D band_data;')
    expect(gvs).toContain('texelFetch(state_tex,')
    expect(gvs).toContain('texelFetch(origin_tex,')
    expect(gvs).not.toMatch(/\btexture\(/) // no filtered sample survives into the vertex stage
    expect(gfs).toContain('void main()')
    expect(gfs).toContain('discard;')
  })
})

// #1419 — THE HALF THAT STILL LOOKS RIGHT WHEN IT IS WRONG.
//
// "The arrows move" is easy to see and easy to get right. The failure that survives a look is an
// arrow that MOVES while keeping the colour and size it launched with: a smooth animation
// reporting a current that is not under it. The catalogue binds symbol, colour, rotation and
// scale to (speed, direction) AT THE POSITION — so what has to be pinned is that every one of
// those comes from the field where the arrow IS, not where it started.
//
// Traced through the emitted WGSL rather than asserted as a substring, because the compiler
// names its own temporaries: resolve the binding that holds the decoded STATE position, then
// require the velocity fetches to use it. A regression that samples `origin_tex` instead would
// keep every arrow's launch colour — and would still animate perfectly.
describe('#1419 advected arrow — re-symbolized from the field UNDER it', () => {
  const w = emitArrowRetainedAdvectedWgsl()
  /** `let X = <expr>;` → the expression, for the emitter's generated temporaries. */
  const letOf = (name: string): string => {
    const m = new RegExp(`let ${name} = ([^;]+);`).exec(w)
    expect(m, `${name} must be bound in the emitted VS`).not.toBeNull()
    return m![1]!
  }
  /** Resolve a chain of single-alias `let`s (`let a = b.x;`) down to its root binding. */
  const rootOf = (name: string): string => {
    let cur = name
    for (let i = 0; i < 8; i++) {
      const e = letOf(cur)
      const alias = /^(_cse\d+|_v\d+|_lc\d+)(\.[xyzw])?$/.exec(e)
      if (!alias) return e
      cur = alias[1]!
    }
    return letOf(cur)
  }

  it('samples the velocity pair at the STATE position — never at the origin', () => {
    for (const tex of ['flow_u_tex', 'flow_v_tex']) {
      // The coordinate is the OWNER cell of the position (#1511): `clamp(floor(uv·(n−1) + 0.5))`.
      // Only the innermost `uv` symbol matters to this claim — which texture the position was
      // decoded from — so the wrapper is matched and stepped over rather than asserted here; the
      // rounding itself is `arrow-density-cull.test.ts`'s claim.
      const load = new RegExp(
        `textureLoad\\(${tex}, vec2<i32>\\(i32\\(clamp\\(floor\\(\\(\\((\\w+) \\*`,
      ).exec(w)
      expect(load, `${tex} must be read with textureLoad`).not.toBeNull()
      const root = rootOf(load![1]!)
      expect(root, `${tex} is sampled where the arrow IS`).toContain('textureLoad(state_tex')
      expect(root).toContain('decode_arrow_pos')
      expect(root, `${tex} must NOT be sampled at the launch cell`).not.toContain('origin_tex')
    }
  })

  it('the band index, the SCALE and the TINT all derive from that sampled speed', () => {
    // One expression feeds all three, so an arrow cannot change colour without changing size,
    // and cannot change either without having moved into different water.
    const cmp = /_v\d+ = select\(1u, _v\d+, \((\w+) < band_data\[0u\]\)\)/.exec(w)
    expect(cmp, 'band 1 is decided by comparing a speed against band_data[0]').not.toBeNull()
    const speed = letOf(cmp![1]!)
    expect(speed, 'the speed is the magnitude of the two sampled components').toMatch(
      /^length\(vec2<f32>\(_cse\d+, _cse\d+\)\)$/,
    )
    const [uSample, vSample] = /length\(vec2<f32>\((\w+), (\w+)\)\)/.exec(speed)!.slice(1)
    expect(letOf(uSample!)).toContain('textureLoad(flow_u_tex')
    expect(letOf(vSample!)).toContain('textureLoad(flow_v_tex')
    // …and the colour is a band ROW, not anything carried per instance.
    expect(w).toMatch(
      /\.tint = vec4<f32>\(band_data\[\(\w+ \+ 4u\)\], band_data\[\(\w+ \+ 5u\)\], band_data\[\(\w+ \+ 6u\)\], band_data\[\(\w+ \+ 7u\)\]\)/,
    )
  })

  it('the origin is used ONLY to measure how far the arrow has drifted', () => {
    // Its one legitimate consumer is the displacement. If it also reached the field sample or
    // the band lookup, the arrow would report its launch cell forever.
    const originLet = /let (\w+) = decode_arrow_pos\(textureLoad\(origin_tex/.exec(w)
    expect(originLet).not.toBeNull()
    const name = originLet![1]!
    const uses = [...w.matchAll(new RegExp(`\\b${name}\\b`, 'g'))]
    expect(uses.length, 'bound once, then read for x and y').toBeLessThanOrEqual(3)
    for (const line of w.split('\n')) {
      if (!line.includes(name) || line.includes('= decode_arrow_pos')) continue
      expect(line, 'the origin never reaches a field sample').not.toContain('flow_')
      expect(line, 'the origin never reaches the catalogue table').not.toContain('band_data')
    }
  })
})
