// Converter + evaluator: Mapbox `["distance", <GeoJSON>]` → the CPU
// `distance(get("$geometry"), <points>, <segments>, <polygons>)` builtin.
// Pairs with eval/distance.test.ts (the metric).

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'
import { Parser } from '../parser/parser'
import { Lexer } from '../lexer/lexer'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  return { result: exprToXgis(mapbox as never, warnings), warnings }
}

function evalSrc(src: string, props: Record<string, unknown>): unknown {
  const tokens = new Lexer(`let __t = ${src}`).tokenize()
  const ast = new Parser(tokens).parse() as { body: Array<{ kind: string; value?: unknown }> }
  const stmt = ast.body.find((s) => s.kind === 'LetStatement') as { value?: unknown } | undefined
  return evaluate(stmt!.value as never, props)
}

describe('distance converter', () => {
  it('Point target → points list, empty segments + polygons', () => {
    const { result, warnings } = convert(['distance', { type: 'Point', coordinates: [0, 1] }])
    expect(warnings).toEqual([])
    expect(result).toBe('distance(get("$geometry"), [[0, 1]], [], [])')
  })

  it('LineString target → segment pairs', () => {
    const { result } = convert([
      'distance',
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0, 1],
          [0, 2],
        ],
      },
    ])
    expect(result).toBe('distance(get("$geometry"), [], [[[0, 0], [0, 1]], [[0, 1], [0, 2]]], [])')
  })

  it('Polygon target → ring-set in polygons AND edges in segments', () => {
    const { result } = convert([
      'distance',
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    ])
    expect(result).toBe(
      'distance(get("$geometry"), [], [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 0]]], [[[[0, 0], [1, 0], [1, 1], [0, 0]]]])',
    )
  })

  it('non-geometry argument drops with a warning', () => {
    const { result, warnings } = convert(['distance', { type: 'Nonsense' }])
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes('["distance"]'))).toBe(true)
  })

  it('end-to-end: distance to a point evaluates to ~110 km', () => {
    const { result } = convert(['distance', { type: 'Point', coordinates: [0, 1] }])
    const d = evalSrc(result as string, {
      $geometry: { type: 'Point', coordinates: [0, 0] },
    }) as number
    expect(d).toBeGreaterThan(110000)
    expect(d).toBeLessThan(111000)
  })
})
