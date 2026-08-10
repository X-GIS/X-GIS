// ═══ Where the arrow field's DENSITY comes from, pinned at the emit (#1450 B, #1511, #1520) ═══
//
// The arm-time stride read the cell COUNT and nothing about the view (`coverage-arrow-show.ts`
// `arrowStride`), so zoomed out the arrows piled into a few pixels and zoomed in the field stayed
// as sparse as the arm decided. #1511 answered that with a finer seeded lattice plus a
// power-of-two decimation in the VS — and #1520 measured that answer running out: `sub²` per cell
// scales with the GRID, so at z17 not one seeded node was inside the viewport and the field
// painted NOTHING.
//
// The density question is now answered by construction rather than by a rule. The instance set IS
// a lattice on the screen, so `nodes per screen area` is a constant the CPU picks and the shader
// never has to correct for a grid it cannot see. There is no decimation level, no lattice index,
// and no seeded spacing — those slots are gone from the band table and the assertions that pinned
// them with it.
//
// WHAT IS PROVEN HERE and what is not. These are EMIT facts — that the walk costs what it should,
// and that every velocity fetch reads the cell that OWNS its position. That the field actually
// paints across z7…z19 is a render claim and is gated where render claims belong:
// `playground/e2e/_s111-arrow-density-gate.spec.ts`. The CPU half of the density rule (the
// viewport → instance count map) is pinned in `map/src/render/field-lattice-uniform.test.ts`.

import { describe, it, expect } from 'vitest'
import { emitArrowRetainedAdvectedWgsl, emitArrowRetainedAdvectedGlsl } from './arrow-advected'
import { ARROW_TRAIN_STEPS } from './arrow-drift'

describe('the STATIC arrow VS is untouched by any of it', () => {
  it('declares no lattice, no view block and no backward map', () => {
    // #1450's endpoint is one portrayal; until then the static path keeps its arm-time stride and
    // its byte-identical shader. A change here would be scope this increment did not take.
    const w = emitArrowRetainedAdvectedWgsl()
    const before = w.slice(0, w.indexOf('fn vs_arrow_retained_advected'))
    expect(before).not.toContain('fn vs_arrow_retained(')
  })
})

describe('the streamline walk costs what it should — no re-inlined tap chain (#1520)', () => {
  // THE ONLY SYMPTOM OF LOSING THIS IS A SILENTLY ~4x MORE EXPENSIVE SHADER, which is why it is a
  // gate and not a comment. An unbound expression node is re-inlined at EVERY read, texture fetch
  // and all — and the velocity pair is read by the direction it builds and by the step length.
  // Leaving them unbound took the predecessor to 38 fetches on both backends against 10.
  //
  // Established by CUTTING each candidate, not by reading: the walk's mutable accumulator was the
  // first diagnosis and cutting its binding changed nothing at all.
  //
  // The budget is exact and derived, not a ceiling picked to pass: every integration step reads
  // both components once (mortality only, at the OWNER cell) — `ARROW_TRAIN_STEPS * 2` — plus
  // ONE validity-gated bilinear read after the walk settles (#1565), which is exactly 4 corners
  // × 2 components = 8 more. The end-of-walk RAW-POSITION pair #1558 removed stays removed: this
  // is not that fetch coming back, it is a wider one spent on purpose — the walk's own samples
  // still decide mortality, only the glyph's drawn colour/length/heading now blend across the
  // node's valid neighbours instead of reading the single cell that owns `posLive`.
  const budget = ARROW_TRAIN_STEPS * 2 + 8

  it('fetches the velocity pair once per step plus one 4-corner blend, and never more', () => {
    const w = emitArrowRetainedAdvectedWgsl()
    expect((w.match(/textureLoad\(flow_[uv]_tex/g) ?? []).length).toBe(budget)
  })

  it('the GLSL twin pays the same — one backend must not carry a re-inlined chain', () => {
    const g = emitArrowRetainedAdvectedGlsl('vertex')
    expect((g.match(/texelFetch\(flow_[uv]_tex/g) ?? []).length).toBe(budget)
  })
})

describe('the velocity fetch reads the cell that OWNS the position (#1511)', () => {
  // The reason this is a shader-TEXT assertion rather than a numeric one: the failure it guards
  // is a coordinate CONVENTION, and a convention is only visible where the coordinate is turned
  // into a texel. Origins are written as `u = col / (n - 1)`, so the owner is `round(u·(n-1))`.
  // The old `floor(u·n)` skewed by up to a whole cell, which was invisible at one arrow per cell
  // (the skew never reached 1, so the answer came out right by luck) and puts a SUB-CELL node on
  // its neighbour — usually reading land's packed (0,0) and collapsing the arrow to nothing.
  //
  // #1565 gave the walk's OWN taps a second consumer with a DIFFERENT convention on purpose — the
  // post-walk bilinear blend reads four FRACTIONAL corners, not one rounded owner — so this test
  // now splits the fetches by that convention rather than asserting one rule over all of them.
  const w = emitArrowRetainedAdvectedWgsl()
  const g = emitArrowRetainedAdvectedGlsl('vertex')

  it('the WALK TAPS scale by (dim - 1) and round, on BOTH backends', () => {
    // Read off the VELOCITY FETCH ITSELF, not off the whole shader. `floor(… + 0.5)` and
    // `clamp(` both occur elsewhere in this module — the density cull rounds a lattice index and
    // the FS clamps its coverage — so a whole-source match is green whatever the fetch does. It
    // was: the first version of this test passed with the skewed fetch restored, which is §12's
    // assertion that fails either way.
    for (const [name, src, fetch] of [
      ['wgsl', w, /textureLoad\(flow_[uv]_tex, (.*?), 0u\)/g],
      ['glsl', g, /texelFetch\(flow_[uv]_tex, (.*?), int\(0u\)\)/g],
    ] as const) {
      const allCoords = [...src.matchAll(fetch)].map((m) => m[1]!)
      // Only the WALK'S taps are inlined at the fetch (`loadAtUv`'s `owner()` helper is not
      // `Let`-bound, by design — see its own comment). The post-walk blend's corners ARE
      // `Let`-bound, so their fetch argument is a bare reference, never this `floor(…+0.5)` text —
      // which is exactly the property that lets this test tell the two conventions apart without
      // hand-maintaining a count.
      const ownerCoords = allCoords.filter((c) => /floor\(.*\+ 0\.5\)/.test(c))
      expect(ownerCoords.length, `${name}: ${ARROW_TRAIN_STEPS} taps × 2 components`).toBe(
        ARROW_TRAIN_STEPS * 2,
      )
      for (const c of ownerCoords) {
        expect(c, `${name} clamps the owner into range`).toMatch(/clamp\(/)
        // …and the scale is the uv convention's own span. The emitter hoists it, so follow the
        // symbol to its definition rather than trusting the fetch to spell it out: a bare `dim`
        // is the skew this fixes, and it is one character away.
        const scale = /clamp\(floor\(\(\(([\w.]+) \* (\w+)\) \+ 0\.5\)\)/.exec(c)?.[2]
        expect(scale, `${name} scales the uv by a hoisted span`).toBeTruthy()
        // Search BACKWARDS from this fetch, not the whole source: the emitter reuses local
        // names across functions, so a forward scan happily finds `_cse2 = radians(lat_deg)`
        // in the projection helper and asserts against the wrong line.
        const before = src.slice(0, src.indexOf(c))
        const defs = [...before.matchAll(new RegExp(`\\b${scale} = ([^;]+);`, 'g'))]
        expect(defs.length, `${name}: ${scale} is bound before it is used`).toBeGreaterThan(0)
        expect(defs[defs.length - 1]![1]!, `${name}: ${scale} is (dim - 1), not dim`).toMatch(
          /- 1\.0/,
        )
      }
    }
  })

  it('does NOT round with `round` — the two backends disagree about a tie', () => {
    // WGSL rounds halves to even; GLSL's tie is implementation-defined. A node landing exactly on
    // a footprint boundary would then resolve to different cells on the two backends, which is a
    // parity bug visible on only one of them. `floor(x + 0.5)` is the same on both.
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    expect(vs.slice(0, vs.indexOf('\n}'))).not.toMatch(/\bround\(/)
  })
})

describe('the post-walk blend reads FOUR fractional corners, never the owner rounding (#1565)', () => {
  // The complement of the test above: the corners must NOT carry the `+ 0.5` owner rounding
  // (that would silently collapse the blend back to a single-cell read, undoing the whole
  // feature while every OTHER assertion here stays green) and must still be clamped into the
  // texture's own range so an edge node cannot read past it.
  const w = emitArrowRetainedAdvectedWgsl()

  it('none of the four corner coordinates contain the owner-cell `+ 0.5` rounding', () => {
    const coords = [...w.matchAll(/textureLoad\(flow_u_tex, (.*?), 0u\)/g)].map((m) => m[1]!)
    expect(coords.length, 'one flow_u_tex fetch per walk tap plus one per corner').toBe(
      ARROW_TRAIN_STEPS + 4,
    )
    const cornerCoords = coords.filter((c) => !/floor\(.*\+ 0\.5\)/.test(c))
    expect(cornerCoords.length, 'four corners, each a bare Let reference').toBe(4)
    for (const ref of cornerCoords) {
      // `Let`-bound, so the fetch argument is just a name — follow it to its definition and
      // confirm THAT is a `vec2<i32>` built from two `floor`/`min`-based (never `+ 0.5`) terms,
      // clamped into `[0, dim − 1]` upstream by the same hoisted `(dim − 1)` scale the walk taps
      // use (`fx`/`fy`'s own `clamp`).
      const before = w.slice(0, w.indexOf(`textureLoad(flow_u_tex, ${ref}, 0u)`))
      const def = [...before.matchAll(new RegExp(`\\b${ref} = (vec2<i32>\\([^;]+);`, 'g'))].pop()
      expect(def, `${ref} is a vec2<i32> corner, bound before its fetch`).toBeTruthy()
      expect(def![1], `${ref} does not re-derive the owner's +0.5 rounding`).not.toMatch(/\+ 0\.5/)
    }
  })
})

describe('a node on ground another region OWNS is culled, on both backends (#1585)', () => {
  // Two overlapping mosaic domains each enumerate a lattice over the shared water. Both drawing
  // there is not a cosmetic doubling — `arrow-drift.ts` states the rule it breaks ("overlapping
  // SCAROW symbols read as a faster current than the data says"), which is the same rule
  // `ARROW_LATTICE_FACTOR` exists to keep. The tie goes to the first-armed region, matching
  // `coverage-bounds.ts` and `coverageHandleAt`, so the drawn field agrees with the queried value.
  //
  // ASSERTED AT THE EMIT because the alternative is invisible: a suppression term that is computed
  // and then not multiplied in compiles, runs, costs the same, and draws the doubled field.

  it('the suppression is a FACTOR of the size product, not a dangling let', () => {
    const w = emitArrowRetainedAdvectedWgsl()
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    const body = vs.slice(0, vs.indexOf('\n}'))
    const call = /let (\w+) = field_owned_elsewhere\(/.exec(body)
    expect(call, 'the VS asks whether this ground is owned elsewhere').not.toBeNull()
    const name = call![1]!
    // `size` is one long product; the term must appear inside it as `(1.0 - owned)`. Reading the
    // product rather than the whole body is the point — a `let` nobody multiplies is the failure.
    const size = /let \w+ = \(*basePx[^;]*;/.exec(body) ?? /\* \(1\.0 - \w+\)/.exec(body)
    expect(size, 'a size product exists to read').not.toBeNull()
    expect(body, 'the term is subtracted from one and multiplied in').toMatch(
      new RegExp(`\\* \\(1\\.0 - ${name}\\)`),
    )
  })

  it('the GLSL twin culls too — a mosaic must not double-draw on one backend only', () => {
    const g = emitArrowRetainedAdvectedGlsl('vertex')
    expect(g, 'the fn is emitted').toContain('field_owned_elsewhere')
    const call = /(\w+) = field_owned_elsewhere\(/.exec(g)
    expect(call).not.toBeNull()
    expect(g).toMatch(new RegExp(`\\* \\(1\\.0 - ${call![1]!}\\)`))
  })

  it('all FOUR slots are read — a truncated unroll silently stops suppressing', () => {
    // The slots are filled in order and the tail is an empty interval, so a loop that read only
    // the first would be correct for one overlapper and wrong for two, which is the harder case
    // to notice and the one real mosaics reach (wcofs ⊃ sfbofs, plus a neighbour).
    for (const [name, src] of [
      ['wgsl', emitArrowRetainedAdvectedWgsl()],
      ['glsl', emitArrowRetainedAdvectedGlsl('vertex')],
    ] as const) {
      for (const slot of ['own_0', 'own_1', 'own_2', 'own_3']) {
        expect(src, `${name} reads ${slot}`).toContain(slot)
      }
    }
  })
})
