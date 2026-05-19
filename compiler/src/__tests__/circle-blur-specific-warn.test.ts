// Iter 99: promote circle-blur from generic ignoredText aggregator
// to a specific layer-level warning naming the missing per-feature
// blur attribute. Parallel to icon-color / circle-translate / line-
// translate / fill-extrusion-translate specific gap warnings.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

function buildCircle(paint: Record<string, unknown>): unknown {
  return {
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
        'circle-radius': 4,
        ...paint,
      },
    }],
  }
}

describe('circle-blur specific gap warning', () => {
  it('circle-blur authored → specific warn (not generic ignoredText)', () => {
    const w = warningsOf(buildCircle({ 'circle-blur': 0.5 }))
    expect(w.some(s =>
      s.includes('circle-blur')
      && s.includes('per-feature blur')
      && s.includes('Plan §4'),
    )).toBe(true)
    // Should NOT also surface in the generic ignored-properties blob
    // (the iter 99 promotion).
    expect(w.some(s =>
      s.includes('ignored properties')
      && s.includes('circle-blur'),
    )).toBe(false)
  })

  it('layer WITHOUT circle-blur does NOT warn', () => {
    const w = warningsOf(buildCircle({}))
    expect(w.some(s => s.includes('circle-blur'))).toBe(false)
  })
})
