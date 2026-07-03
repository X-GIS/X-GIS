// Mapbox spec recognises only `linear` / `exponential` / `cubic-bezier`
// curve types for `interpolate`. An unknown curve name silently falls
// through to linear, dropping the authored intent without diagnostic.
// Iter 78 surfaces this at compile time so typos are visible.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

describe('interpolate unknown curve type spec gate', () => {
  it('zoom-interp with unknown curve "wobbly" warns specifically', () => {
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
            'line-width': ['interpolate', ['wobbly'], ['zoom'], 5, 1, 15, 8],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('unknown curve') && s.includes('wobbly'))).toBe(true)
  })

  it('data-driven with unknown curve "smoothy" warns specifically', () => {
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
            'circle-radius': ['interpolate', ['smoothy'], ['get', 'rank'], 0, 1, 10, 20],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('unknown curve') && s.includes('smoothy'))).toBe(true)
  })

  it('zoom-interp with valid linear curve does NOT warn', () => {
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
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 15, 8],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('unknown curve'))).toBe(false)
  })

  it('zoom-interp with valid exponential curve does NOT warn', () => {
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
            'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 5, 1, 15, 8],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('unknown curve'))).toBe(false)
  })

  it('zoom-interp with valid cubic-bezier curve does NOT warn', () => {
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
              'interpolate',
              ['cubic-bezier', 0.42, 0, 0.58, 1],
              ['zoom'],
              5,
              1,
              15,
              8,
            ],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('unknown curve'))).toBe(false)
  })
})
