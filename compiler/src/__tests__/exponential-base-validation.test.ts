// Mapbox spec: exponential interpolate base must be > 0 (and != 1).
// Negative / zero base produces a degenerate curve at the evaluator
// (pow(neg, frac) → NaN, pow(0, neg) → Infinity). Pre-fix the
// converter accepted any finite value and emitted the bad base,
// leaving NaN-corrupted output at runtime with no diagnostic.
// Iter 83 surfaces this gap on both paint.ts (zoom-interp) and
// expressions.ts (data-driven) paths.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

describe('exponential base validation', () => {
  it('zoom-interp with base=0 warns + falls back to linear', () => {
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
          'line-width': ['interpolate', ['exponential', 0], ['zoom'],
            5, 1, 15, 8],
        },
      }],
    })
    expect(w.some(s =>
      s.includes('exponential')
      && s.includes('must be > 0'),
    )).toBe(true)
  })

  it('zoom-interp with base=-2 warns + falls back to linear', () => {
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
          'line-width': ['interpolate', ['exponential', -2], ['zoom'],
            5, 1, 15, 8],
        },
      }],
    })
    expect(w.some(s =>
      s.includes('exponential')
      && s.includes('must be > 0'),
    )).toBe(true)
  })

  it('data-driven with base=0 warns', () => {
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
          'circle-radius': ['interpolate', ['exponential', 0], ['get', 'rank'],
            0, 1, 10, 20],
        },
      }],
    })
    expect(w.some(s =>
      s.includes('exponential')
      && s.includes('must be > 0'),
    )).toBe(true)
  })

  it('valid exponential base > 0 does NOT warn', () => {
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
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'],
            5, 1, 15, 8],
        },
      }],
    })
    expect(w.some(s => s.includes('must be > 0'))).toBe(false)
  })

  it('base=1 (= linear collapse) does NOT warn', () => {
    // base === 1 is mathematically linear — the converter collapses
    // it silently to the cheap linear code path. No warning either.
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
          'line-width': ['interpolate', ['exponential', 1], ['zoom'],
            5, 1, 15, 8],
        },
      }],
    })
    expect(w.some(s => s.includes('must be > 0'))).toBe(false)
  })
})
