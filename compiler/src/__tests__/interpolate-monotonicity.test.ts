// Mapbox spec gate: `interpolate` / `interpolate-lab` / `interpolate-hcl`
// stops must be in strictly ascending order on the input axis. Non-
// monotonic stops produce undefined evaluator output (the runtime
// scan picks the first range matching the input — silently wrong).
// Iter 74 surfaces this at compile time with a specific warning
// across both paint.ts (zoom-interp) and expressions.ts (data-driven)
// paths.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

describe('interpolate stops monotonicity', () => {
  it('zoom-interp with reverse-ordered stops warns specifically', () => {
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
          'line-width': ['interpolate', ['linear'], ['zoom'],
            20, 8,
            10, 1,
          ],
        },
      }],
    })
    expect(w.some(s => s.includes('not strictly ascending'))).toBe(true)
  })

  it('zoom-interp with duplicate-zoom stops warns specifically', () => {
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
          'line-width': ['interpolate', ['linear'], ['zoom'],
            10, 1,
            10, 5,
          ],
        },
      }],
    })
    expect(w.some(s => s.includes('not strictly ascending'))).toBe(true)
  })

  it('zoom-interp with ascending stops does NOT warn', () => {
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
          'line-width': ['interpolate', ['linear'], ['zoom'],
            5, 0.5,
            10, 1,
            20, 8,
          ],
        },
      }],
    })
    expect(w.some(s => s.includes('not strictly ascending'))).toBe(false)
  })

  it('data-driven with reverse-ordered stops warns specifically', () => {
    // The non-zoom input path lives in expressions.ts; the gate
    // there is parallel to paint.ts.
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
          'circle-radius': ['interpolate', ['linear'], ['get', 'rank'],
            10, 8,
            0, 1,
          ],
        },
      }],
    })
    expect(w.some(s => s.includes('not strictly ascending'))).toBe(true)
  })

  it('one warning per non-monotonic interpolate, not per pair', () => {
    // Style with TWO non-monotonic pairs in the same interpolate —
    // should still only emit one warning (gate breaks on first).
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
          'line-width': ['interpolate', ['linear'], ['zoom'],
            20, 8,
            10, 1,
            5, 0.5,
          ],
        },
      }],
    })
    const monoWarns = w.filter(s => s.includes('not strictly ascending'))
    expect(monoWarns.length).toBe(1)
  })
})
