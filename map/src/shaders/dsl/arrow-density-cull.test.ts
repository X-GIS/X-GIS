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
  // both components — and that is ALL. The end-of-walk pair went with #1558: the glyph
  // re-symbolizes at its last LIVE footing, whose velocity the loop iteration that recorded it
  // had already fetched, so a second read of the same cell was paying for a value the walk
  // already held.
  const budget = ARROW_TRAIN_STEPS * 2

  it('fetches the velocity pair exactly once per step, and never again', () => {
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
  const w = emitArrowRetainedAdvectedWgsl()
  const g = emitArrowRetainedAdvectedGlsl('vertex')

  it('scales by (dim - 1) and rounds, on BOTH backends', () => {
    // Read off the VELOCITY FETCH ITSELF, not off the whole shader. `floor(… + 0.5)` and
    // `clamp(` both occur elsewhere in this module — the density cull rounds a lattice index and
    // the FS clamps its coverage — so a whole-source match is green whatever the fetch does. It
    // was: the first version of this test passed with the skewed fetch restored, which is §12's
    // assertion that fails either way.
    for (const [name, src, fetch] of [
      ['wgsl', w, /textureLoad\(flow_[uv]_tex, (.*?), 0u\)/g],
      ['glsl', g, /texelFetch\(flow_[uv]_tex, (.*?), int\(0u\)\)/g],
    ] as const) {
      const coords = [...src.matchAll(fetch)].map((m) => m[1]!)
      // Not an exact count — the walk's steps fetch too, and their budget is pinned by its own
      // test above. What matters HERE is that EVERY fetch, step or symbolization, reads the owner
      // cell: a step that read a neighbour would walk the train through the wrong water.
      expect(coords.length, `${name} fetches the velocity pair`).toBeGreaterThanOrEqual(2)
      for (const c of coords) {
        // `floor(x + 0.5)` — the nearest cell under point registration.
        expect(c, `${name} rounds the fetch to the nearest cell`).toMatch(/floor\(.*\+ 0\.5\)/)
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
