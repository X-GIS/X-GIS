// Mapbox spec: text-size / line-width are non-negative. Pre-fix the
// converter silently clamped negative authored values to 0 with no
// diagnostic — the layer rendered invisible at the affected stops
// and the author had no clue why their typo'd negative value
// disappeared. Iter 84 surfaces the clamp.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

describe('negative numeric clamp warnings', () => {
  it('text-size with negative literal warns + still emits clamped utility', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}', 'text-size': -10 },
        paint: { 'text-color': '#000' },
      }],
    })
    expect(w.some(s => s.includes('text-size') && s.includes('negative'))).toBe(true)
  })

  it('line-width with negative literal warns + still emits clamped utility', () => {
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
          'line-width': -3,
        },
      }],
    })
    expect(w.some(s => s.includes('line-width') && s.includes('negative'))).toBe(true)
  })

  it('text-size with valid positive literal does NOT warn', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}', 'text-size': 16 },
        paint: { 'text-color': '#000' },
      }],
    })
    expect(w.some(s => s.includes('text-size') && s.includes('negative'))).toBe(false)
  })

  it('line-width=0 (valid, hides line) does NOT warn', () => {
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
          'line-width': 0,
        },
      }],
    })
    expect(w.some(s => s.includes('line-width') && s.includes('negative'))).toBe(false)
  })
})
