// ═══ View-driven arrow density, pinned at the layout and the emitted shader (#1450 B, #1511) ═══
//
// The arm-time stride reads the cell COUNT and nothing about the view (`coverage-arrow-show.ts`
// `arrowStride`), so zoomed out the arrows pile into a few pixels and zoomed in the field stays
// as sparse as the arm decided — and could never be denser than the grid, because nothing made a
// second arrow for one cell. The generator now seeds a finer lattice and the advected VS keeps
// every 2^L-th node of it, so one rule runs in both directions.
//
// WHAT IS PROVEN HERE and what is not. These are LAYOUT and EMIT facts — that the lattice reaches
// the shader, that the shader reads it, and that the cull rides the existing zero-the-size
// mechanism rather than a second one. That the field ACTUALLY thins on zoom-out and FILLS on
// zoom-in is a render claim and is gated where render claims belong:
// `playground/e2e/_s111-arrow-density-gate.spec.ts`.
//
// The numeric rule is deliberately NOT restated in TypeScript here. A CPU mirror of the shader's
// decimation would be a second authority for one rule, which is the drift §12 keeps paying for —
// the emitted text and the render gate are the two authorities that cannot silently disagree.

import { describe, it, expect } from 'vitest'
import { emitArrowRetainedAdvectedWgsl, emitArrowRetainedAdvectedGlsl } from './arrow-retained'
import {
  S111_BAND_PARAMS_ROW,
  S111_BAND_STRIDE,
  S111_PARAM_STEPS_U,
  S111_PARAM_STEPS_V,
  S111_PARAM_UV_ASPECT,
  S111_PARAM_STATE_BASE,
} from './s111-band-table-layout'
import { s111BandTableNormalized } from '../../render/s111-portrayal'
import { ARROW_DRIFT_TAPS } from './arrow-drift'

const paramsAt = (t: Float32Array, slot: number): number =>
  t[S111_BAND_PARAMS_ROW * S111_BAND_STRIDE + slot]!

describe('the seeded lattice reaches the shader (#1450 B, #1511)', () => {
  it('the params row carries the steps per uv unit when a lattice is declared', () => {
    const t = s111BandTableNormalized(2, 1.3, 's111-speed', [595 * 4, 432 * 4])
    expect(paramsAt(t, S111_PARAM_STEPS_U)).toBe(2380)
    expect(paramsAt(t, S111_PARAM_STEPS_V)).toBe(1728)
  })

  it('the new slots do not disturb the two the row already carried', () => {
    // The params row is shared, and a slot collision would be invisible: the arrows would keep
    // drawing, pointed by a uvAspect that is really a lattice step count.
    const withLattice = s111BandTableNormalized(2, 1.3, 's111-speed', [2380, 1728])
    expect(paramsAt(withLattice, S111_PARAM_UV_ASPECT)).toBeCloseTo(1.3, 6) // f32 round-trip
    expect(paramsAt(withLattice, S111_PARAM_STATE_BASE)).toBe(0)
    expect(S111_PARAM_STEPS_U).not.toBe(S111_PARAM_UV_ASPECT)
    expect(S111_PARAM_STEPS_U).not.toBe(S111_PARAM_STATE_BASE)
    expect(S111_PARAM_STEPS_V).not.toBe(S111_PARAM_STEPS_U)
  })

  it('an UNDECLARED lattice leaves the slots zero — the shader reads that as "do not thin"', () => {
    // Zero must mean the whole field, not maximum decimation: a caller with no lattice to declare
    // would otherwise silently lose its arrows.
    const t = s111BandTableNormalized(2, 1.3)
    expect(paramsAt(t, S111_PARAM_STEPS_U)).toBe(0)
    expect(paramsAt(t, S111_PARAM_STEPS_V)).toBe(0)
  })

  it('the band rows are untouched by the params row gaining slots', () => {
    const a = s111BandTableNormalized(2, 1.3, 's111-speed')
    const b = s111BandTableNormalized(2, 1.3, 's111-speed', [2380, 1728])
    const bandFloats = S111_BAND_PARAMS_ROW * S111_BAND_STRIDE
    expect([...b.subarray(0, bandFloats)]).toEqual([...a.subarray(0, bandFloats)])
  })
})

describe('the advected VS thins by SCREEN spacing (#1450 B, #1511)', () => {
  const w = emitArrowRetainedAdvectedWgsl()

  it('reads BOTH lattice slots out of the params row, at the indices the layout declares', () => {
    // The index is COMPUTED from the layout constants rather than spelled out, so moving a slot
    // moves this assertion with it instead of leaving a stale magic number that still passes.
    for (const slot of [S111_PARAM_STEPS_U, S111_PARAM_STEPS_V]) {
      const at = S111_BAND_PARAMS_ROW * S111_BAND_STRIDE + slot
      expect(w, `band_data[${at}u] (params row slot ${slot})`).toContain(`band_data[${at}u]`)
    }
  })

  it('derives the level from the projected BASES, not from a camera scalar', () => {
    // The whole point of measuring at the arrow's own position is that a pitched frame decimates
    // its horizon harder than its foreground. A camera-wide stride cannot express that, so a
    // rewrite that reached for one would be a regression this pins.
    expect(w).toMatch(/log2/)
    expect(w).toMatch(/exp2/)
    expect(w).toMatch(/ceil/)
  })

  it('the cull rides the size product — one way for an arrow not to be drawn, not two', () => {
    // `size` is already zeroed for a speed-0 cell and for a failed perspective guard, and a zero
    // length collapses the quad. The density factor multiplies into the SAME product. A separate
    // early-out would be a second mechanism to keep in step with the quad emit below it — so the
    // VS must still have exactly ONE return, and no branch that skips the emit.
    const vs = w.slice(w.indexOf('fn vs_arrow_retained_advected'))
    const body = vs.slice(0, vs.indexOf('\n}'))
    expect(body.match(/\breturn\b/g) ?? []).toHaveLength(1)
    // …and the factor itself is present: the exact-integer test the nesting argument rests on.
    expect(body).toMatch(/fract\(/)
  })

  it('the GLSL twin carries the same thinning — one backend must not draw a denser field', () => {
    const g = emitArrowRetainedAdvectedGlsl('vertex')
    expect(g).toMatch(/log2/)
    expect(g).toMatch(/exp2/)
    expect(g).toMatch(/fract/)
  })

  it('the STATIC arrow VS is untouched — it declares no lattice and thins nothing', () => {
    // #1450's endpoint is one portrayal; until then the static path keeps its arm-time stride
    // and its byte-identical shader. A change here would be scope this increment did not take.
    const vs = w.slice(0, w.indexOf('fn vs_arrow_retained_advected'))
    expect(vs).not.toMatch(/exp2/)
  })
})

describe('the drift costs what it should — no re-inlined tap chain (#1520)', () => {
  // THE ONLY SYMPTOM OF LOSING THIS IS A SILENTLY ~4x MORE EXPENSIVE SHADER, which is why it is a
  // gate and not a comment. An unbound expression node is re-inlined at EVERY read, texture fetch
  // and all — and the velocity pair is read by the nine-band select chain, by the speed, and by
  // both direction components. Leave `vu`/`vv` unbound and the emit goes to 38 fetches on both
  // backends against the 10 below; the stateful VS it replaced had 2.
  //
  // Established by CUTTING each candidate, not by reading: the tap loop's mutable accumulator was
  // the first diagnosis and cutting its binding changed nothing at all.
  //
  // The budget is exact and derived, not a ceiling picked to pass: ARROW_DRIFT_TAPS taps read
  // both components, and the symbolization reads them once more at the final position.
  const budget = ARROW_DRIFT_TAPS * 2 + 2

  it('fetches the velocity pair exactly once per tap, plus once to symbolize', () => {
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
      // Not an exact count — the drift's taps fetch too (#1520), and their budget is pinned by
      // its own test above. What matters HERE is that EVERY fetch, tap or symbolization, reads
      // the owner cell: a tap that read a neighbour would walk the arrow through the wrong water.
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
