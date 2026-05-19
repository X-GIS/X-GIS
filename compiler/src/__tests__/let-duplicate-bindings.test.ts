// Mapbox `["let"]` doesn't formally forbid duplicate binding names
// but the evaluator semantic for them is undefined. Our substitution
// uses Map.set — LAST write wins — so earlier duplicate bindings
// become silent dead code that the author probably didn't intend.
// Iter 77 surfaces this at compile time so the gap is visible.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

describe('let duplicate-binding spec gate', () => {
  it('let with duplicate binding names warns with name', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'l',
        type: 'line',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'line-color': '#fff',
          'line-width': ['let',
            'r', 1,
            'r', 5,  // duplicate
            ['var', 'r']],
        },
      }],
    })
    expect(w.some(s => s.includes('duplicate binding') && s.includes('"r"'))).toBe(true)
  })

  it('let with unique binding names does NOT warn', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'l',
        type: 'line',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'line-color': '#fff',
          'line-width': ['let',
            'r', 1,
            's', 5,
            ['+', ['var', 'r'], ['var', 's']]],
        },
      }],
    })
    expect(w.some(s => s.includes('duplicate binding'))).toBe(false)
  })

  it('triple duplicate emits a single warning naming all collisions', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'l',
        type: 'circle',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'circle-color': '#000',
          'circle-stroke-color': '#000',
          'circle-stroke-width': 1,
          'circle-radius': ['let',
            'x', 1,
            'x', 2,
            'x', 3,
            ['var', 'x']],
        },
      }],
    })
    const dupes = w.filter(s => s.includes('duplicate binding'))
    expect(dupes.length).toBe(1)
    // The warning should mention "x" only once even though it was
    // duplicated twice (set semantics).
    expect(dupes[0]).toContain('"x"')
  })
})
