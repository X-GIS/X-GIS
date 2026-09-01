// ═══ hillshade `resampling: linear` is authored, not rendered (#2166 L3) ═══
//
// The DEM height is RGB-packed and decoded in the fragment, so the sampler MUST
// be nearest — bilinear over packed bytes corrupts the decode
// (shaders/dsl/hillshade.ts). HillshadeDraper therefore binds ONE nearest
// sampler and the fragment reads a nearest 3x3 stencil, whatever the style
// authored. `linear` is the Mapbox spec DEFAULT for hillshade resampling, so
// every hillshade layer already renders the non-default; that part is a
// documented residual (its own `partial` coverage row).
//
// What was NOT acceptable is that an author who TYPES `resampling: "linear"`
// got the same silence as one who omitted it — the converter's own comment
// called the default "byte-identical", which is false in the opposite
// direction: `nearest` is what renders, and the emitted
// `hillshade-resampling-nearest` utility reaches no runtime reader at all.
// This pins the diagnostic and, just as importantly, pins that adding it moved
// no utility — the emitted set for an explicit `linear` is byte-identical to
// the omitted case, which is why this change cannot move a pixel.

import { describe, it, expect } from 'vitest'
import { emitHillshadePaint } from '../convert/paint-hillshade'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import type { MapboxLayer } from '../convert/types'

function emit(paint: Record<string, unknown>): { out: string[]; warnings: string[] } {
  const out: string[] = []
  const warnings: string[] = []
  emitHillshadePaint(out, { id: 'hs', type: 'hillshade' } as MapboxLayer, paint, warnings)
  return { out, warnings }
}
const RESAMPLING_WARN = /resampling/i

/** utility list → IR → ShowCommand, so the PRESENCE half of the coverage claim
 *  is measured on the EMITTED SHOW rather than on the converter string. The
 *  converter half of the chain (Mapbox `resampling: nearest` → the
 *  `hillshade-resampling-nearest` utility) is pinned by the arm above; this picks
 *  the chain up AT that utility and carries it through binding → render node →
 *  emitted show. */
function compileHillshadeShow(utilities: string) {
  const src = `xgis 1
source demsrc { type: "raster-dem" url: "/dem-fixture.png" encoding: mapbox }
layer relief { source: demsrc | ${utilities} }
`
  const shows = emitCommands(optimize(lower(new Parser(new Lexer(src).tokenize()).parse()))).shows
  return shows[0]!
}

describe('hillshade resampling diagnostics (#2166 L3)', () => {
  it('an EXPLICIT `linear` warns that the DEM is sampled nearest regardless', () => {
    const { warnings } = emit({ resampling: 'linear' })
    const hit = warnings.filter((w) => RESAMPLING_WARN.test(w))
    expect(
      hit.length,
      'an explicitly authored `resampling: "linear"` produced no diagnostic — the author asked ' +
        'for linear DEM smoothing and silently got the nearest 3x3 stencil',
    ).toBe(1)
    expect(hit[0]).toMatch(/nearest/)
  })

  it('`nearest` is honoured at convert time and must NOT warn', () => {
    const { out, warnings } = emit({ resampling: 'nearest' })
    expect(out).toContain('hillshade-resampling-nearest')
    expect(
      warnings.filter((w) => RESAMPLING_WARN.test(w)),
      'authoring `nearest` matches what the fragment does — warning here would be noise',
    ).toEqual([])
  })

  it('an OMITTED resampling stays silent (the converter is silent on every default)', () => {
    const { warnings } = emit({})
    expect(
      warnings.filter((w) => RESAMPLING_WARN.test(w)),
      'the un-authored default must not warn — it would fire on every hillshade layer in ' +
        'every style; that residual is carried by the `resampling` coverage row instead',
    ).toEqual([])
  })

  it('an unrecognised value still warns, and says what the spec allows', () => {
    const { warnings } = emit({ resampling: 'cubic' })
    expect(warnings.some((w) => /unrecognised/.test(w) && /linear/.test(w))).toBe(true)
  })

  // The coverage + capability rows assert a TWO-SIDED fact: `nearest` converts
  // "end to end — utility, binding, render node, resamplingNearest on the emitted
  // show — and reaches no runtime reader at all". Only the ABSENCE half was bound
  // (by hillshade-nearest-sampler-authority.test.ts, a source-tree scan). This
  // binds the PRESENCE half, whose sole producer is emit-commands-hillshade.ts:56.
  // Without it that line reads as dead code — it genuinely has no runtime reader,
  // which is exactly what the sibling gate asserts — and deleting it would leave
  // every gate in this PR green while two coverage rows and the generated
  // gap-matrix started stating a falsehood about the compiler (#2218 review).
  it('`nearest` reaches the EMITTED SHOW as resamplingNearest, and omitting it does not', () => {
    expect(
      compileHillshadeShow('hillshade-exaggeration-0.7 hillshade-resampling-nearest').paintShapes
        .hillshade!.resamplingNearest,
      'an authored `resampling: "nearest"` did not reach HillshadeShapes.resamplingNearest on ' +
        'the emitted show — the `resampling` coverage + capability rows claim it converts end ' +
        'to end (utility → binding → render node → emitted show)',
    ).toBe(true)
    expect(
      compileHillshadeShow('hillshade-exaggeration-0.7').paintShapes.hillshade!.resamplingNearest,
      'an UN-authored resampling emitted resamplingNearest anyway — the spec default is ' +
        '`linear`, which is `false` on this field',
    ).toBe(false)
  })

  it('the diagnostic moves NO utility — explicit `linear` emits exactly what omitting it does', () => {
    const omitted = emit({ 'hillshade-exaggeration': 0.7 })
    const explicit = emit({ 'hillshade-exaggeration': 0.7, resampling: 'linear' })
    expect(
      explicit.out,
      'the `linear` diagnostic changed the emitted utility set — it must be a conversion note ' +
        'only, or the §5 render exemption for this change is void',
    ).toEqual(omitted.out)
  })
})
