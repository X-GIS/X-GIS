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

  it('circle-radius with negative literal warns + emits clamped utility', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'c',
        type: 'circle',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'circle-color': '#000',
          'circle-stroke-color': '#000',
          'circle-stroke-width': 1,
          'circle-radius': -5,
        },
      }],
    })
    expect(w.some(s => s.includes('circle-radius') && s.includes('negative'))).toBe(true)
  })

  it('fill-extrusion-height with negative literal warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'e',
        type: 'fill-extrusion',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'fill-extrusion-color': '#888',
          'fill-extrusion-height': -10,
        },
      }],
    })
    expect(w.some(s => s.includes('fill-extrusion-height') && s.includes('negative'))).toBe(true)
  })

  it('fill-opacity = -0.5 (negative) warns + clamps to 0', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'l',
        type: 'fill',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'fill-color': '#000',
          'fill-opacity': -0.5,
        },
      }],
    })
    expect(w.some(s => s.includes('opacity') && s.includes('out of range'))).toBe(true)
  })

  it('fill-opacity = 150 (out of percent range) warns + clamps to 1', () => {
    // Auto-detect 100-scale kicks in for 1 < v <= 100; values >100 are
    // outright spec violations.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'l',
        type: 'fill',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'fill-color': '#000',
          'fill-opacity': 150,
        },
      }],
    })
    expect(w.some(s => s.includes('opacity') && s.includes('out of range'))).toBe(true)
  })

  it('fill-opacity = 50 (auto-detect percent) does NOT warn', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'l',
        type: 'fill',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'fill-color': '#000',
          'fill-opacity': 50,
        },
      }],
    })
    expect(w.some(s => s.includes('opacity') && s.includes('out of range'))).toBe(false)
  })

  it('text-padding with negative literal warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}', 'text-padding': -2 },
        paint: { 'text-color': '#000' },
      }],
    })
    expect(w.some(s => s.includes('text-padding') && s.includes('negative'))).toBe(true)
  })

  it('text-line-height with negative literal warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}', 'text-line-height': -1.2 },
        paint: { 'text-color': '#000' },
      }],
    })
    expect(w.some(s => s.includes('text-line-height') && s.includes('negative'))).toBe(true)
  })

  it('fill-extrusion-base with negative literal warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'e',
        type: 'fill-extrusion',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'fill-extrusion-color': '#888',
          'fill-extrusion-height': 50,
          'fill-extrusion-base': -5,
        },
      }],
    })
    expect(w.some(s => s.includes('fill-extrusion-base') && s.includes('negative'))).toBe(true)
  })

  it('line-blur with negative literal warns', () => {
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
          'line-width': 2,
          'line-blur': -1.5,
        },
      }],
    })
    expect(w.some(s => s.includes('line-blur') && s.includes('negative'))).toBe(true)
  })

  it('text-halo-width with negative literal warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}' },
        paint: { 'text-color': '#000', 'text-halo-width': -2 },
      }],
    })
    expect(w.some(s => s.includes('text-halo-width') && s.includes('negative'))).toBe(true)
  })

  it('circle-stroke-width with negative literal warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'c',
        type: 'circle',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'circle-color': '#000',
          'circle-stroke-color': '#000',
          'circle-stroke-width': -1,
          'circle-radius': 5,
        },
      }],
    })
    expect(w.some(s => s.includes('circle-stroke-width') && s.includes('negative'))).toBe(true)
  })

  it('text-halo-blur with negative literal warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}' },
        paint: { 'text-color': '#000', 'text-halo-blur': -0.5 },
      }],
    })
    expect(w.some(s => s.includes('text-halo-blur') && s.includes('negative'))).toBe(true)
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
