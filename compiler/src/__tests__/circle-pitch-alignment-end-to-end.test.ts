// End-to-end propagation for circle-pitch-alignment (#2118), the sibling of
// circle-pitch-scale-end-to-end.test.ts. Mapbox style → convertMapboxStyle →
// Lexer → Parser → lower → optimize → emitCommands →
// ShowCommand.circlePitchAlignmentMap. The runtime (PointRenderer) raises the
// point uniform's circle_params.w mode code to 2 and the point VS maps the quad's
// local axes through the ground basis, so the disc lies in the ground plane and
// foreshortens into an ellipse under pitch.
//
// 'viewport' IS this knob's spec default (the sibling's is 'map' — they are
// opposites, and that asymmetry is the part a re-derivation gets wrong). So the
// converter emits NOTHING for viewport/absent, lower leaves the field undefined,
// and the render stays byte-identical to today. That is the regression rung, and
// the rows below are what keep a future edit from quietly moving it.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(mapboxStyle: unknown): string {
  return convertMapboxStyle(mapboxStyle as Parameters<typeof convertMapboxStyle>[0])
}

function compileToShows(mapboxStyle: unknown): ReturnType<typeof emitCommands>['shows'] {
  const tokens = new Lexer(convert(mapboxStyle)).tokenize()
  const ast = new Parser(tokens).parse()
  return emitCommands(optimize(lower(ast))).shows
}

function circleLayer(paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [
      {
        id: 'c',
        type: 'circle',
        source: 't',
        'source-layer': 'p',
        paint: { 'circle-radius': 4, 'circle-color': '#08f', ...paint },
      },
    ],
  }
}

describe('circle-pitch-alignment — converter emit', () => {
  it("'map' → emits circle-pitch-alignment-map utility", () => {
    const src = convert(circleLayer({ 'circle-pitch-alignment': 'map' }))
    expect(src).toContain('circle-pitch-alignment-map')
  })

  it("'viewport' (explicit spec default) → NO utility (byte-identical billboard)", () => {
    const src = convert(circleLayer({ 'circle-pitch-alignment': 'viewport' }))
    expect(src).not.toContain('circle-pitch-alignment')
  })

  it('absent → NO utility (byte-identical default)', () => {
    const src = convert(circleLayer({}))
    expect(src).not.toContain('circle-pitch-alignment')
  })

  it('["literal", "map"] wrap → unwrapped + emits the flag', () => {
    const src = convert(circleLayer({ 'circle-pitch-alignment': ['literal', 'map'] }))
    expect(src).toContain('circle-pitch-alignment-map')
  })

  it("'map' + explicit 'viewport' scale → DEFERRED: no utility (degrades to today)", () => {
    // The one refused pairing. It must emit NOTHING rather than approximate:
    // silently dropping to the un-compensated basis would show the author a disc
    // that shrinks with distance when they explicitly asked it not to.
    const src = convert(
      circleLayer({ 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'viewport' }),
    )
    expect(src).not.toContain('circle-pitch-alignment-map')
  })

  it("'map' + explicit 'map' scale → BOTH utilities emit (alignment resolves the pair)", () => {
    const src = convert(
      circleLayer({ 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map' }),
    )
    expect(src).toContain('circle-pitch-alignment-map')
    expect(src).toContain('circle-pitch-scale-map')
  })
})

describe('circle-pitch-alignment — enum validation survived the rewrite', () => {
  it("a typo'd value still warns (it used to, via the `ignored` sweep)", () => {
    // #2118 moved circle-pitch-alignment OUT of the ignored-properties sweep,
    // which is where a bad enum used to be surfaced. Dropping the property from
    // that list must not silently drop its validation too — this is the row that
    // would have caught it.
    const warnings: string[] = []
    convertMapboxStyle(circleLayer({ 'circle-pitch-alignment': 'sideways' }) as never, {
      coverage: { sources: [], layers: [], warnings },
    })
    expect(warnings.some((w) => w.includes('not a valid enum'))).toBe(true)
  })

  it("'auto' is still tolerated silently, exactly as before", () => {
    const warnings: string[] = []
    convertMapboxStyle(circleLayer({ 'circle-pitch-alignment': 'auto' }) as never, {
      coverage: { sources: [], layers: [], warnings },
    })
    expect(warnings.some((w) => w.includes('circle-pitch-alignment'))).toBe(false)
  })
})

describe('circle-pitch-alignment → ShowCommand.circlePitchAlignmentMap (IR carry)', () => {
  it("'map' → ShowCommand.circlePitchAlignmentMap === true", () => {
    const shows = compileToShows(circleLayer({ 'circle-pitch-alignment': 'map' }))
    expect(shows[0]!.circlePitchAlignmentMap).toBe(true)
  })

  it("'viewport' → circlePitchAlignmentMap undefined (DEFAULT reproduces today)", () => {
    const shows = compileToShows(circleLayer({ 'circle-pitch-alignment': 'viewport' }))
    expect(shows[0]!.circlePitchAlignmentMap).toBeUndefined()
  })

  it('absent → circlePitchAlignmentMap undefined (DEFAULT reproduces today)', () => {
    const shows = compileToShows(circleLayer({}))
    expect(shows[0]!.circlePitchAlignmentMap).toBeUndefined()
  })

  it('the two knobs ride INDEPENDENT fields — neither aliases the other', () => {
    // They are opposites by spec and an enum by the time they reach the GPU, so a
    // single shared field would be an easy and invisible mistake at the IR seam.
    const a = compileToShows(circleLayer({ 'circle-pitch-alignment': 'map' }))[0]!
    expect(a.circlePitchAlignmentMap).toBe(true)
    expect(a.circlePitchScaleMap).toBeUndefined()
    const s = compileToShows(circleLayer({ 'circle-pitch-scale': 'map' }))[0]!
    expect(s.circlePitchScaleMap).toBe(true)
    expect(s.circlePitchAlignmentMap).toBeUndefined()
  })
})
