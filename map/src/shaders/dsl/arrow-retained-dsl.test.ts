import { describe, it, expect } from 'vitest'
import {
  emitArrowRetainedWgsl,
  emitArrowRetainedGlsl,
  emitArrowRetainedAdvectedWgsl,
  emitArrowRetainedAdvectedGlsl,
} from './arrow-retained'
import { ARROW_DRIFT_UV, ARROW_DRIFT_TAPS } from './arrow-drift'

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

  it('binds the velocity pair and the band table — no arrow STATE, and NO tint', () => {
    expect(w).toContain('@group(1) @binding(0) var<storage, read> feat_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(1) var<storage, read> band_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(2) var flow_u_tex: texture_2d<f32>;')
    expect(w).toContain('@group(1) @binding(3) var flow_v_tex: texture_2d<f32>;')
    // The state and origin textures used to sit at 2 and 3. Their absence is the whole of
    // #1520 — an arrow's position is a function of its origin and the frame clock, so nothing
    // per-arrow is stored anywhere, and the instance count is bounded by no texture.
    expect(w).not.toContain('state_tex')
    expect(w).not.toContain('origin_tex')
    // The colour is the band the arrow is standing in, so there is no launch colour to keep.
    expect(w).not.toContain('tint_data')
  })

  it('reads every texture with textureLoad — textureSample is illegal in a vertex stage', () => {
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

  it('scales the displacement by the SAME leash the drift integrates over', () => {
    // The anchors are packed one ARROW_DRIFT_UV away, so this division is what makes the
    // multiplier land in [-1, 1] — the range the linearization is valid over. The leash now has
    // one home (`arrow-drift.ts`) and three consumers: the generator that packs the anchors, the
    // integration that walks the arrow, and this division.
    expect(w).toContain(`/ ${ARROW_DRIFT_UV}`)
  })

  it('the drift is FITTED into that range by SCALING, not clamped per component', () => {
    // The stateful path got the bound for free: the step recycled an arrow the moment it passed
    // the leash, so the VS never saw a larger displacement. Integrating the position means
    // nothing enforces it upstream, so the VS does — but it must do it by scaling BOTH
    // components by one factor. Clamping them independently also keeps the displacement inside
    // the box and TURNS it, which is the reported "moves in a different direction than it
    // points" (see arrow-drift-direction.test.ts for the angles).
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    const body = vs.slice(0, vs.indexOf('\n}'))
    expect(body, 'the fit is capped at 1 — it may shrink the drift, never grow it').toMatch(
      /min\(1\.0,/,
    )
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
    expect(gvs).toContain('texelFetch(flow_u_tex,')
    expect(gvs).toContain('texelFetch(flow_v_tex,')
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

  it('samples the velocity pair where the arrow IS — a DRIFTED position, never the origin', () => {
    // The failure this pins has not changed with the mechanism (#1520): an arrow that moves while
    // keeping the colour and size it launched with is a smooth animation reporting a current that
    // is not under it. What changed is where the position comes from — it used to be decoded from
    // a state texture, and it is now integrated in the shader from the origin over the phase.
    //
    // So the claim is structural: the fetch coordinate must be a variable that the tap loop
    // REASSIGNS, initialised from the origin. A shader that sampled at the origin itself would
    // match neither half.
    const walk = /var (_v\d+): vec2<f32> = (\w+);/.exec(w)
    expect(walk, 'the drift walks a mutable position').not.toBeNull()
    const [sym, seed] = [walk![1]!, walk![2]!]

    const assigns = [...w.matchAll(new RegExp(`^\\s*${sym} = [^\\n]*$`, 'gm'))].map((m) => m[0])
    expect(assigns, 'one assignment per integration tap').toHaveLength(ARROW_DRIFT_TAPS)
    for (const a of assigns) {
      expect(a, 'each tap advances by the FIELD, not by a constant').toContain('flow_u_tex')
      expect(a, 'each tap advances by the FIELD, not by a constant').toContain('flow_v_tex')
    }

    // …and the walk starts at the instance's own origin, read from the feat record.
    expect(letOf(seed), 'the walk starts at the origin').toMatch(/feat_data/)

    for (const tex of ['flow_u_tex', 'flow_v_tex']) {
      const load = new RegExp(
        `textureLoad\\(${tex}, vec2<i32>\\(i32\\(clamp\\(floor\\(\\(\\((\\w+)\\.x \\*`,
      ).exec(w)
      expect(load, `${tex} must be read with textureLoad`).not.toBeNull()
      expect(load![1]!, `${tex} is sampled at the walked position`).toBe(sym)
    }
  })

  it('the band index, the SCALE and the TINT all derive from that sampled speed', () => {
    // One expression feeds all three, so an arrow cannot change colour without changing size,
    // and cannot change either without having moved into different water.
    const cmp =
      /select\(1u, _v\d+, \(length\(vec2<f32>\((\w+), (\w+)\)\) < band_data\[0u\]\)\)/.exec(w)
    expect(cmp, 'band 1 is decided by comparing a speed against band_data[0]').not.toBeNull()
    const [uSample, vSample] = [cmp![1]!, cmp![2]!]
    expect(letOf(uSample), 'the speed magnitude is built from the SAMPLED u').toContain(
      'textureLoad(flow_u_tex',
    )
    expect(letOf(vSample), 'the speed magnitude is built from the SAMPLED v').toContain(
      'textureLoad(flow_v_tex',
    )
    // …and the colour is a band ROW, not anything carried per instance. Alpha carries the phase
    // fade on top (#1520) — the FADE touches only alpha, so a fading arrow never reads as a
    // different speed band, which is why the rgb triple is still asserted verbatim.
    expect(w).toMatch(
      /\.tint = vec4<f32>\(band_data\[\(\w+ \+ 4u\)\], band_data\[\(\w+ \+ 5u\)\], band_data\[\(\w+ \+ 6u\)\], \(band_data\[\(\w+ \+ 7u\)\] \* arrow_phase_alpha\(/,
    )
  })

  it('the origin seeds the walk and the phase — it never reaches the catalogue lookup', () => {
    // Its legitimate consumers are the displacement it is measured against, the walk it starts,
    // and the phase offset hashed from it. If it ALSO reached the field sample or the band
    // lookup, the arrow would report its launch cell forever — which is the failure that still
    // looks like a working animation.
    const originLet = /let (\w+) = vec2<f32>\(feat_data\[[^\]]+\], feat_data\[[^\]]+\]\);/.exec(w)
    expect(originLet, 'the origin is bound once from the feat record').not.toBeNull()
    const name = originLet![1]!
    for (const line of w.split('\n')) {
      if (!line.includes(name)) continue
      // The origin DOES meet `band_data` — the lattice steps the density cull measures with live
      // in the params row. What it must never reach is a BAND decision: the select chain that
      // picks the row, or the tint built from it. That is the difference between "which arrows
      // are drawn" and "what speed this arrow reports".
      expect(line, 'the origin never decides a band').not.toContain('select(1u,')
      expect(line, 'the origin never reaches the tint').not.toContain('.tint =')
    }
  })
})
