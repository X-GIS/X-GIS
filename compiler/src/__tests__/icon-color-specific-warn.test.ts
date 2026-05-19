// Mapbox icon-color (SDF tint) is not yet plumbed through X-GIS'
// IconStage — needs a per-vertex tint attribute + fragment multiply
// (Plan §4 deferred). Iter 88 promoted the gap from the generic
// ignoredText aggregator to a specific layer-level warning naming
// the missing tint plumbing, parallel to the iter 14-17 pattern
// for line-gradient / fill-pattern / line-pattern.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

describe('icon-color specific gap warning', () => {
  it('icon-color hex → specific tint warning (not generic ignoredText)', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'shield',
        type: 'symbol',
        source: 'v',
        'source-layer': 'transportation',
        layout: { 'icon-image': 'us-interstate-3' },
        paint: { 'icon-color': '#ff0000' },
      }],
    })
    expect(w.some(s =>
      s.includes('icon-color')
      && s.includes('SDF')
      && s.includes('Plan §4'),
    )).toBe(true)
    // The icon-color gap should NOT also surface in the generic
    // "ignored properties" blob (the iter 88 removal from that list).
    expect(w.some(s =>
      s.includes('ignored properties')
      && s.includes('icon-color'),
    )).toBe(false)
  })

  it('icon-color expression form (e.g. case) still warns specifically', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'shield',
        type: 'symbol',
        source: 'v',
        'source-layer': 'transportation',
        layout: { 'icon-image': 'us-interstate-3' },
        paint: {
          'icon-color': ['case', ['==', ['get', 'kind'], 'interstate'], '#0000ff', '#888'],
        },
      }],
    })
    expect(w.some(s =>
      s.includes('icon-color')
      && s.includes('Plan §4'),
    )).toBe(true)
  })

  it('layer WITHOUT icon-color does NOT warn', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'shield',
        type: 'symbol',
        source: 'v',
        'source-layer': 'transportation',
        layout: { 'icon-image': 'us-interstate-3' },
        paint: {},
      }],
    })
    expect(w.some(s => s.includes('icon-color'))).toBe(false)
  })
})
