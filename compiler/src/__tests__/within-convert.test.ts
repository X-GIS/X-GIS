// Converter: Mapbox `["within", <GeoJSON>]` → xgis `within(get("$geometry"), …)`.
// Pairs with eval/within.test.ts (the runtime predicate) and
// eval/within-evaluator.test.ts (parse + evaluate of the emitted source).

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  const result = exprToXgis(mapbox as never, warnings)
  return { result, warnings }
}

const POLY = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
}

describe('within converter', () => {
  it('Polygon → within(get("$geometry"), <MultiPolygon-shaped coords>)', () => {
    const { result, warnings } = convert(['within', POLY])
    expect(warnings).toEqual([])
    // Normalised to MultiPolygon form (one extra nesting level).
    expect(result).toBe(
      'within(get("$geometry"), [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]])',
    )
  })

  it('MultiPolygon → two polygons preserved', () => {
    const mp = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
        [
          [
            [5, 5],
            [6, 5],
            [6, 6],
            [5, 5],
          ],
        ],
      ],
    }
    const { result, warnings } = convert(['within', mp])
    expect(warnings).toEqual([])
    expect(result).toBe(
      'within(get("$geometry"), [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]])',
    )
  })

  it('Feature wrapper is unwrapped to its geometry', () => {
    const { result } = convert(['within', { type: 'Feature', properties: {}, geometry: POLY }])
    expect(result).toBe(
      'within(get("$geometry"), [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]])',
    )
  })

  it('non-polygon argument (e.g. Point) drops with a warning', () => {
    const { result, warnings } = convert(['within', { type: 'Point', coordinates: [0, 0] }])
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes('["within"]'))).toBe(true)
  })

  it('wrong arity drops with a warning', () => {
    const { result, warnings } = convert(['within', POLY, POLY])
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes('Malformed ["within"]'))).toBe(true)
  })
})
