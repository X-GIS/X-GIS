// End-to-end propagation test for text-font weight through the
// Mapbox style → convertMapboxStyle → Lexer → Parser → lower →
// optimize → emitCommands pipeline. User reported 2026-05-18 that
// text "appears thinner than actual" in OFM Bright; one hypothesis
// (Phase B.1 of the compat plan, memory note
// project_maplibre_compat_plan_2026_05_18) is that fontWeight=700
// is dropped somewhere in the pipeline so Bold labels render at
// Regular weight.
//
// Pure CPU — no GPU, no glyph fetch — so it runs in CI as the
// regression gate. If a future refactor regresses fontWeight
// propagation, the runtime symptom would be "Bold labels look
// thin in MapLibre A/B" — easy to miss without a focused test.
// This pins every intermediate value: parsed font name, emitted
// xgis utility, lowered LabelDef, and final ShowCommand shape.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { parseMapboxFontName } from '../convert/layers'

function compileToShows(mapboxStyle: unknown): ReturnType<typeof emitCommands>['shows'] {
  const xgisSource = convertMapboxStyle(mapboxStyle as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgisSource).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return emitCommands(optimize(scene, ast)).shows
}

function makeStyle(layers: unknown[]): unknown {
  return {
    version: 8,
    sources: { test: { type: 'vector', tiles: ['http://x.test/{z}/{x}/{y}.pbf'] } },
    layers,
  }
}

function symbolLayer(id: string, font: string[]): unknown {
  return {
    id,
    type: 'symbol',
    source: 'test',
    'source-layer': 'place',
    layout: {
      'text-field': '{name}',
      'text-font': font,
      'text-size': 14,
    },
  }
}

describe('fontWeight propagation — Mapbox style → ShowCommand', () => {
  it('"Noto Sans Bold" → parsed weight 700 → emitted label-font-weight-700 utility', () => {
    expect(parseMapboxFontName('Noto Sans Bold')).toEqual({
      family: 'Noto Sans',
      weight: 700,
    })
    const style = makeStyle([symbolLayer('bold', ['Noto Sans Bold'])])
    const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
    expect(xgis).toContain('label-font-weight-700')
  })

  it('Bold label survives lower + emit-commands as ShowCommand.label.fontWeight=700', () => {
    const shows = compileToShows(makeStyle([symbolLayer('bold', ['Noto Sans Bold'])]))
    expect(shows.length).toBe(1)
    expect(shows[0]!.label).toBeDefined()
    expect(shows[0]!.label!.fontWeight).toBe(700)
  })

  it('Regular label has NO fontWeight emitted (runtime defaults to 400)', () => {
    const shows = compileToShows(makeStyle([symbolLayer('regular', ['Noto Sans Regular'])]))
    expect(shows[0]!.label).toBeDefined()
    // Regular = weight 400 = the runtime default; the converter
    // intentionally skips emitting the utility (layers.ts:867) so
    // the runtime fallback path takes over. Pre-fix Regular emitted
    // 400 explicitly and bloated the utility list with no behavior
    // change.
    expect(shows[0]!.label!.fontWeight).toBeUndefined()
  })

  it('Italic label propagates fontStyle="italic" — no weight emit at 400', () => {
    const shows = compileToShows(makeStyle([symbolLayer('italic', ['Noto Sans Italic'])]))
    expect(shows[0]!.label).toBeDefined()
    expect(shows[0]!.label!.fontStyle).toBe('italic')
    expect(shows[0]!.label!.fontWeight).toBeUndefined()
  })

  it('Bold Italic label propagates both fontWeight=700 AND fontStyle="italic"', () => {
    const shows = compileToShows(makeStyle([symbolLayer('bi', ['Noto Sans Bold Italic'])]))
    expect(shows[0]!.label).toBeDefined()
    expect(shows[0]!.label!.fontWeight).toBe(700)
    expect(shows[0]!.label!.fontStyle).toBe('italic')
  })

  it('Heavy maps to 900 (iter 397 fix; previously stuck at 800)', () => {
    expect(parseMapboxFontName('Noto Sans Heavy')).toEqual({
      family: 'Noto Sans',
      weight: 900,
    })
    const shows = compileToShows(makeStyle([symbolLayer('heavy', ['Noto Sans Heavy'])]))
    expect(shows[0]!.label!.fontWeight).toBe(900)
  })

  it('case-insensitive "Semibold" maps to 600 (iter ~144 fix; pre-fix was Regular fallback)', () => {
    expect(parseMapboxFontName('Open Sans Semibold')).toEqual({
      family: 'Open Sans',
      weight: 600,
    })
    const shows = compileToShows(makeStyle([symbolLayer('semi', ['Open Sans Semibold'])]))
    expect(shows[0]!.label!.fontWeight).toBe(600)
  })

  it('multi-entry font stack ["Noto Sans Bold", "Noto Sans CJK KR Bold"] keeps weight=700', () => {
    // OFM-style stack: primary script + CJK fallback. parser.layers.ts
    // emits ONE label-font-weight-700 from the first matching stack
    // entry. Verifies the loop at layers.ts:867 doesn't get confused
    // by the second entry's "Bold" overriding to a different value.
    const shows = compileToShows(
      makeStyle([symbolLayer('cjk', ['Noto Sans Bold', 'Noto Sans CJK KR Bold'])]),
    )
    expect(shows[0]!.label!.fontWeight).toBe(700)
  })
})
