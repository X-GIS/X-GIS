// line-translate end-to-end propagation test.
// Mirrors fill-translate-end-to-end.test.ts: Mapbox style →
// convertMapboxStyle → Lexer → Parser → lower → optimize →
// emitCommands → ShowCommand.strokeTranslateX/Y.
// Runtime: VTR bakes CSS px → NDC-per-pixel into u.line_translate_x/y
// (line uniform slots 47/48); vs_line applies post-MVP.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function compileToShows(mapboxStyle: unknown): ReturnType<typeof emitCommands>['shows'] {
  const xgisSource = convertMapboxStyle(mapboxStyle as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgisSource).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return emitCommands(optimize(scene, ast)).shows
}

function lineLayer(id: string, paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [{ id, type: 'line', source: 't', 'source-layer': 'r', paint }],
  }
}

describe('line-translate — Mapbox → ShowCommand.strokeTranslateX/Y', () => {
  it('absent line-translate → both undefined (no offset)', () => {
    const shows = compileToShows(lineLayer('plain', { 'line-color': '#888' }))
    expect(shows[0]!.strokeTranslateX).toBeUndefined()
    expect(shows[0]!.strokeTranslateY).toBeUndefined()
  })

  it('[0, 0] → both undefined (default, no-op)', () => {
    const shows = compileToShows(
      lineLayer('zero', {
        'line-color': '#888',
        'line-translate': [0, 0],
      }),
    )
    expect(shows[0]!.strokeTranslateX).toBeUndefined()
    expect(shows[0]!.strokeTranslateY).toBeUndefined()
  })

  it('[2, 3] → x=2, y=3', () => {
    const shows = compileToShows(
      lineLayer('pos', {
        'line-color': '#888',
        'line-translate': [2, 3],
      }),
    )
    expect(shows[0]!.strokeTranslateX).toBe(2)
    expect(shows[0]!.strokeTranslateY).toBe(3)
  })

  it('[-2, -3] → x=-2, y=-3 via bracket form', () => {
    const shows = compileToShows(
      lineLayer('neg', {
        'line-color': '#888',
        'line-translate': [-2, -3],
      }),
    )
    expect(shows[0]!.strokeTranslateX).toBe(-2)
    expect(shows[0]!.strokeTranslateY).toBe(-3)
  })

  it('only x non-zero: [4, 0] → x=4, y undefined', () => {
    const shows = compileToShows(
      lineLayer('xOnly', {
        'line-color': '#888',
        'line-translate': [4, 0],
      }),
    )
    expect(shows[0]!.strokeTranslateX).toBe(4)
    expect(shows[0]!.strokeTranslateY).toBeUndefined()
  })

  it('only y non-zero: [0, -5] → x undefined, y=-5', () => {
    const shows = compileToShows(
      lineLayer('yOnly', {
        'line-color': '#888',
        'line-translate': [0, -5],
      }),
    )
    expect(shows[0]!.strokeTranslateX).toBeUndefined()
    expect(shows[0]!.strokeTranslateY).toBe(-5)
  })

  it('v8 ["literal", [dx, dy]] wrap unwraps to constant', () => {
    const shows = compileToShows(
      lineLayer('v8wrap', {
        'line-color': '#888',
        'line-translate': ['literal', [-1, 3]],
      }),
    )
    expect(shows[0]!.strokeTranslateX).toBe(-1)
    expect(shows[0]!.strokeTranslateY).toBe(3)
  })

  it('null → both undefined (spec fallback, no warning)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(
      lineLayer('nullt', { 'line-color': '#888', 'line-translate': null }) as never,
      { coverage },
    )
    expect(coverage.warnings.some((w) => w.includes('line-translate'))).toBe(false)
  })

  it('line-translate does NOT appear in ignored-paint warning list', () => {
    const xgis = convertMapboxStyle(
      lineLayer('w', {
        'line-color': '#888',
        'line-translate': [2, -3],
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    expect(xgis).not.toContain('ignored paint properties: line-translate')
  })
})
