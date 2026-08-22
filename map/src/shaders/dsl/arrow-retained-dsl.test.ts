import { describe, it, expect } from 'vitest'
import { emitArrowRetainedWgsl, emitArrowRetainedGlsl } from './arrow-retained'
import { emitArrowRetainedAdvectedWgsl, emitArrowRetainedAdvectedGlsl } from './arrow-advected'
import { ARROW_TRAIN_GLYPHS, ARROW_TRAIN_STEPS } from './arrow-drift'
import { matchArc } from './_arrow-emit-nav'

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
    expect(vs).toContain('_sfetch(feat_data,') // the fetch is a helper CALL since #1878
    expect(vs).toContain('_sfetch(tint_data,')
    expect(vs).toContain('float _sfetch(sampler2D t, int i) {') // …and the unit defines it
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
    // The fill comes from the `tint` VARYING directly since #1867 — the entry's IO struct
    // is read field-wise, so it is substituted away rather than gathered into `in_`.
    expect(fs).toMatch(/mix\(tint\.xyz, vec3\(0\.0, 0\.0, 0\.0\), max\(/)
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
      'field_view',
      'unproject_flat',
      'ray_hit_sphere_enu',
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

describe('#1520 advected-arrow shader — the screen lattice, in the emitted bytes', () => {
  const w = emitArrowRetainedAdvectedWgsl()

  it('binds NO per-instance record at all — the instance set is the viewport, not the grid', () => {
    // THE DELETION IS THE FEATURE. `feat_data` held one entry per grid cell: an anchor and two
    // projected basis anchors. That is what made the field expire at z17 (#1520 measured 0
    // painted pixels there), because the instance set scaled with the GRID and almost none of it
    // was on screen. An instance is now `(screen seed, glyph)`, so there is nothing per instance
    // to read — and a regression that re-adds a feat binding would be re-adding the ceiling.
    expect(w).not.toContain('feat_data')
    expect(w).toContain('@group(1) @binding(1) var<storage, read> band_data: array<f32>;')
    expect(w).toContain('@group(1) @binding(2) var flow_u_tex: texture_2d<f32>;')
    expect(w).toContain('@group(1) @binding(3) var flow_v_tex: texture_2d<f32>;')
    expect(w).toContain('@group(1) @binding(4) var<uniform> field_view: FieldView;')
    // The state and origin textures used to sit at 2 and 3. Their absence is #1520 step 1 — an
    // arrow's position is a function of its seed and the frame clock, so nothing per-arrow is
    // stored anywhere and the instance count is bounded by no texture.
    expect(w).not.toContain('state_tex')
    expect(w).not.toContain('origin_tex')
    // The colour is the band the glyph is standing in, so there is no launch colour to keep.
    expect(w).not.toContain('tint_data')
  })

  it('hashes the phase from the node’s ABSOLUTE lattice index (#1534)', () => {
    // The jitter has to be a function of WHICH WATER a node is, not of where it currently sits in
    // the enumeration — otherwise every glyph re-rolls its phase as the camera pans and the field
    // boils. Two nearby quantities both look right and are not: the window index `(col, row)`
    // slides with the viewport, and the anchor-relative index `(jx, jy)` shifts a step at a time
    // because the anchor tracks the view centre. The absolute index is `uv / step`, an integer
    // because the anchor is a multiple of the step, and it is the only one that does not move.
    //
    // Asserted structurally rather than by picture, because a still frame cannot show it: a boiling
    // field and a stable one are the same single frame.
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    const body = vs.slice(0, vs.indexOf('\n}'))
    const at = body.indexOf('arrow_phase_offset(')
    expect(at, 'the phase is jittered at all').toBeGreaterThan(-1)
    // The operand is `(uv.x / lattice.x, uv.y / lattice.y)` — a division by the STEP, whether the
    // emitter inlines it or binds it to a temporary first. A hash of an index has no step in it.
    const arg = body.slice(at, body.indexOf(';', at))
    const src = /^arrow_phase_offset\((_v\d+)\)/.exec(arg)
      ? new RegExp(`let ${/^arrow_phase_offset\((_v\d+)\)/.exec(arg)![1]!} = ([^;]+);`).exec(
          body,
        )![1]!
      : arg
    expect(src, 'the phase index is the node uv over the lattice step').toMatch(
      /field_view\.lattice\.x\)[\s\S]*field_view\.lattice\.y\)/,
    )
  })

  it('reads every texture with textureLoad — textureSample is illegal in a vertex stage', () => {
    expect(w).toContain('textureLoad(flow_u_tex')
    expect(w).toContain('textureLoad(flow_v_tex')
    expect(w).not.toContain('textureSample')
    // …and therefore declares no sampler at all, which is also what keeps the WebGL2
    // sampler-follows-its-texture ordering rule out of the vertex stage.
    expect(w).not.toContain(': sampler')
  })

  it('recovers geography by INVERTING the ladder — it projects nothing forward per instance', () => {
    // The direction of the whole pipeline, asserted where a picture cannot show it. A screen node
    // has no geographic anchor to project, so `project_geo` — the forward geo→clip helper the
    // static path is built on — must not appear at all; what appears instead is the backward map.
    expect(w, 'no per-instance forward projection survives').not.toContain('project_geo(')
    expect(w).toContain('field_screen_lonlat(')
    expect(w).toContain('field_grid_uv(')
    expect(w).toContain('field_uv_basis(')
  })

  it('the glyph position is built in SCREEN px with w = 1 — no second anchor to divide by', () => {
    // The predecessor derived two bases by projecting anchors a leash away and dividing each by
    // ITS OWN clip.w. Lower the pitch and an anchor crosses behind the eye plane, w passes through
    // zero, and the glyph is flung off screen — reported as "the particles fly off into space",
    // and it needed a perspective guard. Here the node is a lattice coordinate and the train
    // offset is already in pixels, so the failure is not reachable rather than guarded against.
    // The output is assembled by the entry's CONSTRUCTOR since #1867 (a write-once struct
    // local collapses into one), so @builtin(position) is its FIRST argument rather than a
    // `.position = ` assignment — the claim is unchanged: z and w are the literals 0 and 1,
    // with no clip.w anywhere in the expression to divide by.
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    const out = vs.slice(vs.indexOf('  return ArrowRetainedOut('))
    expect(out, 'the clip w is the literal 1').toMatch(
      /return ArrowRetainedOut\(vec4<f32>\([\s\S]*?,\s*0\.0,\s*1\.0\),/,
    )
  })

  it('holds no catalogue threshold of its own — it indexes the uploaded band table', () => {
    // Nine bands, compared against band_data's own edges. A literal knot value here would be a
    // second authority for the catalogue rule (s111-portrayal.ts owns it).
    expect(w.match(/band_data\[/g)?.length ?? 0).toBeGreaterThanOrEqual(9)
    expect(w).not.toContain('13.0') // band 9's edge, if it had been inlined
  })

  it('emits a GLSL twin per stage, storage lowered to a data texture', () => {
    const gvs = emitArrowRetainedAdvectedGlsl('vertex')
    const gfs = emitArrowRetainedAdvectedGlsl('fragment')
    expect(gvs).toContain('#version 300 es')
    expect(gvs).toContain('void main()')
    expect(gvs).toContain('uniform sampler2D band_data;')
    expect(gvs, 'the view block stays a real UBO on the WebGL2 arm').toContain('FieldView')
    expect(gvs).toContain('texelFetch(flow_u_tex,')
    expect(gvs).toContain('texelFetch(flow_v_tex,')
    expect(gvs).not.toMatch(/\btexture\(/) // no filtered sample survives into the vertex stage
    expect(gfs).toContain('void main()')
    expect(gfs).toContain('discard;')
  })
})

// #1419 — THE HALF THAT STILL LOOKS RIGHT WHEN IT IS WRONG.
//
// "The arrows move" is easy to see and easy to get right. The failure that survives a look is a
// glyph that MOVES while keeping the colour and size its seed launched with: a smooth animation
// reporting a current that is not under it. The catalogue binds symbol, colour, rotation and
// scale to (speed, direction) AT THE POSITION — so what has to be pinned is that every one of
// those comes from the field where the glyph IS, not where its train started.
//
// Traced through the emitted WGSL rather than asserted as a substring, because the compiler names
// its own temporaries: resolve the binding the streamline walk reassigns, then require the
// velocity fetches to use it. A regression that sampled the seed's own uv would keep every train's
// launch colour — and would still animate perfectly.
describe('#1520 advected arrow — re-symbolized from the field UNDER it', () => {
  // SCOPED TO THE VS BODY. The emitter restarts its temporary names at `_v0` in every function,
  // so a module-wide search resolves `_v24` to whichever helper declared one first — which is how
  // a structural assertion silently starts reading a different function's arithmetic and passing
  // (or failing) for a reason that has nothing to do with the claim.
  const all = emitArrowRetainedAdvectedWgsl()
  const w = all.slice(all.indexOf('fn vs_arrow_retained_advected'))
  /** `let X = <expr>;` → the expression, for the emitter's generated temporaries. */
  const letOf = (name: string): string => {
    const m = new RegExp(`let ${name} = ([^;]+);`).exec(w)
    expect(m, `${name} must be bound in the emitted VS`).not.toBeNull()
    return m![1]!
  }

  it('samples the velocity pair where the glyph IS — a WALKED position, never the seed', () => {
    // The claim is structural: the fetch coordinate must be a variable the walk REASSIGNS, seeded
    // from the node's own grid-uv. A shader that sampled at the seed itself would match neither
    // half — and would report the water at the head of the train for every glyph in it.
    const walk = /var (_v\d+): vec2<f32> = (\w+);/.exec(w)
    expect(walk, 'the train walks a mutable position').not.toBeNull()
    const [sym, seed] = [walk![1]!, walk![2]!]

    const assigns = [...w.matchAll(new RegExp(`^\\s*${sym} = \\(${sym} \\+ (\\w+)\\);$`, 'gm'))]
    expect(assigns, 'one assignment per integration step').toHaveLength(ARROW_TRAIN_STEPS)
    for (const a of assigns) {
      expect(letOf(a[1]!), 'each step advances along the FIELD, not by a constant').toContain(
        'field_uv_step(',
      )
    }

    // …and the walk starts at the seed node's own absolute grid-uv. Since #1534 that is the
    // ENUMERATED node — `field_node_uv`'s `zw` lanes, exact by construction — rather than a uv
    // recovered from a screen position, so the assertion follows the swizzle back to its source.
    const node = /^(\w+)\.zw$/.exec(letOf(seed))
    expect(node, 'the walk starts at the node lanes of a vec4').not.toBeNull()
    expect(letOf(node![1]!), 'the walk starts at the ENUMERATED ground node').toContain(
      'field_node_uv(',
    )

    for (const tex of ['flow_u_tex', 'flow_v_tex']) {
      const load = new RegExp(
        `textureLoad\\(${tex}, vec2<i32>\\(i32\\(clamp\\(floor\\(\\(\\((\\w+)\\.x \\*`,
      ).exec(w)
      expect(load, `${tex} must be read with textureLoad`).not.toBeNull()
      expect(load![1]!, `${tex} is sampled at the walked position`).toBe(sym)
    }
  })

  it('the band index, the SCALE and the TINT all derive from that sampled speed', () => {
    // One expression feeds all three, so a glyph cannot change colour without changing size, and
    // cannot change either without having moved into different water.
    const cmp = /select\(1u, \w+, \((\w+) < band_data\[0u\]\)\)/.exec(w)
    expect(cmp, 'band 1 is decided by comparing a speed against band_data[0]').not.toBeNull()
    const speed = /^length\(vec2<f32>\((\w+), (\w+)\)\)$/.exec(letOf(cmp![1]!))
    expect(speed, 'that speed is the magnitude of a sampled velocity pair').not.toBeNull()
    // Since #1565 the pair is a VALIDITY-GATED BILINEAR BLEND across `posLive`'s valid
    // neighbours (`loadInterpolated`), not a single raw fetch — so each component is bound to a
    // division (the weighted sum over its weight total), and that division's four corner terms
    // must themselves be fed by this component's texture. The corner fetches are counted, not
    // parsed out of the weighted-sum expression: `arrow-density-cull.test.ts` already pins there
    // being exactly four of them per component.
    for (const [name, tex] of [
      [speed![1]!, 'flow_u_tex'],
      [speed![2]!, 'flow_v_tex'],
    ] as const) {
      const def = letOf(name)
      expect(def, `${name} is a weighted blend, not a bare fetch`).toContain('/')
      const before = w.slice(0, w.indexOf(`let ${name} = `))
      expect(
        (before.match(new RegExp(`textureLoad\\(${tex}`, 'g')) ?? []).length,
        `${name} is downstream of ${tex}'s four corner fetches`,
      ).toBeGreaterThanOrEqual(4)
    }
    // …and the colour is a band ROW, not anything carried per instance. Alpha carries the train
    // fade on top — the FADE touches only alpha, so a fading glyph never reads as a different
    // speed band, which is why the rgb triple is still asserted verbatim.
    expect(w).toMatch(
      // …as a positional ctor argument now (#1867), not a `.tint = ` assignment.
      /vec4<f32>\(band_data\[\(\w+ \+ 4u\)\], band_data\[\(\w+ \+ 5u\)\], band_data\[\(\w+ \+ 6u\)\], \(band_data\[\(\w+ \+ 7u\)\] \* \w+\)\)/,
    )
  })

  it('the train is exactly G glyphs, and the wrap moves it by exactly ONE spacing', () => {
    // The arc length is `(j + φ)·δ`. That is what makes the wrap invisible: at φ = 1 the set of
    // occupied arc lengths is the set at φ = 0 shifted by one, so every glyph lands where its
    // neighbour was and the alpha — a function of `(j + φ)/G` — matches across the seam. A
    // regression that multiplied the phase by anything else reopens the blink #1333 rejected
    // moving glyphs over.
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    const body = vs.slice(0, vs.indexOf('\n}'))
    // Divided by G, in either EXACT spelling: the optimizer canonicalises a division by a
    // power of two into a multiply by its reciprocal (gcc -O2 does the same), and G is 4.
    // Both forms are asserted from the constant, so this still fails if the divisor moves.
    expect(body, 'the instance splits into seed and glyph by G').toMatch(
      new RegExp(`/ ${ARROW_TRAIN_GLYPHS}\\.0|\\* ${1 / ARROW_TRAIN_GLYPHS}\\b`),
    )
    // By shape, not by spelling — the optimizer may bind the sum to its own name
    // (gvn does, #1865); arrow-excursion-bound.test.ts is where the operands are
    // then proven to BE the glyph index, the phase and the spacing.
    expect(matchArc(body), 'the arc length is (glyph + phase) × spacing').not.toBeUndefined()
  })
})
