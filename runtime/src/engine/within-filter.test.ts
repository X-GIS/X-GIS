// Runtime integration: `applyFilter` honours the Mapbox `["within"]`
// containment predicate on GeoJSON sources. The converter lowers
// `["within", polygon]` to `within(get("$geometry"), <coords>)` (proven in
// compiler/src/__tests__/within-convert.test.ts); here we confirm
// applyFilter injects the `$geometry` reserved key so the predicate
// actually selects features whose geometry lies inside the polygon.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser } from '@xgis/compiler'
import { applyFilter } from '@xgis/map'

// Parse a single xgis expression into the AST shape applyFilter expects.
function parseAst(src: string): unknown {
  const tokens = new Lexer(`let __t = ${src}`).tokenize()
  const program = new Parser(tokens).parse() as { body: Array<{ kind: string; value?: unknown }> }
  const stmt = program.body.find((s) => s.kind === 'LetStatement') as
    { value?: unknown } | undefined
  if (!stmt) throw new Error('let stmt missing')
  return stmt.value
}

// The exact source the converter emits for a 10×10 square at the origin.
const SQUARE = '[[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]]'
const filterExpr = { ast: parseAst(`within(get("$geometry"), ${SQUARE})`) }

const fc = {
  type: 'FeatureCollection' as const,
  features: [
    {
      type: 'Feature',
      id: 'inside',
      properties: {},
      geometry: { type: 'Point', coordinates: [5, 5] },
    },
    {
      type: 'Feature',
      id: 'outside',
      properties: {},
      geometry: { type: 'Point', coordinates: [50, 50] },
    },
    {
      type: 'Feature',
      id: 'multi-in',
      properties: {},
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [2, 2],
          [8, 8],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'multi-straddle',
      properties: {},
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [2, 2],
          [50, 50],
        ],
      },
    },
  ],
}

describe('applyFilter — within containment on GeoJSON', () => {
  it('keeps only features whose geometry is inside the polygon', () => {
    const out = applyFilter(fc as never, filterExpr)
    const ids = out.features.map((f) => (f as { id?: string }).id)
    expect(ids).toEqual(['inside', 'multi-in'])
  })

  it('no filter → pass-through (returns same reference)', () => {
    expect(applyFilter(fc as never, null)).toBe(fc)
  })
})
