// Mapbox spec gate: `match` labels must be unique within a single
// expression. Duplicates produce undefined behaviour (MapLibre uses
// the FIRST matching arm); the second one is silent dead code that
// the author probably didn't notice. Iter 76 surfaces this at compile
// time so the gap is visible.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

describe('match duplicate-label spec gate', () => {
  it('match with duplicate string labels warns specifically', () => {
    // Use line-width (numeric) instead of fill-color so the match
    // expression flows through exprToXgis. The fill-color path takes
    // the expandPerFeatureColorMatch preprocessor that splits into
    // per-colour sublayers BEFORE expressions.ts sees the match.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 'v',
          'source-layer': 'a',
          paint: {
            'line-color': '#fff',
            'line-width': [
              'match',
              ['get', 'class'],
              'motorway',
              4,
              'motorway',
              8, // duplicate
              1,
            ],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('duplicate label') && s.includes('motorway'))).toBe(true)
  })

  it('match with unique labels does NOT warn', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 'v',
          'source-layer': 'a',
          paint: {
            'line-color': '#fff',
            'line-width': [
              'match',
              ['get', 'class'],
              'motorway',
              8,
              'primary',
              4,
              'secondary',
              2,
              1,
            ],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('duplicate label'))).toBe(false)
  })

  it('match with duplicate numeric labels warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 'v',
          'source-layer': 'a',
          paint: {
            'circle-color': '#000',
            'circle-stroke-color': '#000',
            'circle-stroke-width': 1,
            'circle-radius': [
              'match',
              ['get', 'rank'],
              1,
              5,
              1,
              10, // duplicate numeric label
              0,
            ],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('duplicate label'))).toBe(true)
  })

  it('match with duplicates from array-of-labels shorthand still warns', () => {
    // The labels-array form (`[k1, k2]` as a single arm match value)
    // expands to multiple arms internally. Duplicates across the
    // expansion still violate spec.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 'v',
          'source-layer': 'a',
          paint: {
            'line-color': '#fff',
            'line-width': [
              'match',
              ['get', 'class'],
              ['motorway', 'primary'],
              8,
              'motorway',
              4, // motorway duplicated across arms
              1,
            ],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('duplicate label') && s.includes('motorway'))).toBe(true)
  })
})
