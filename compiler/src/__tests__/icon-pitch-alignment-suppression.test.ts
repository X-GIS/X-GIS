// icon-pitch-alignment: viewport / auto match X-GIS billboard
// icon rendering — silent. 'map' would project icons onto ground
// plane (Plan §4 deferred) — warns.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(value: unknown) {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 's',
      type: 'symbol',
      source: 'v',
      'source-layer': 'p',
      layout: {
        'icon-image': 'marker',
        'icon-pitch-alignment': value,
      },
    }],
  }
}

describe('icon-pitch-alignment default suppression', () => {
  it("'viewport' (spec default) → no warning", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('viewport') as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-pitch-alignment'))).toBe(false)
  })

  it("'auto' → no warning (matches X-GIS billboard default)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('auto') as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-pitch-alignment'))).toBe(false)
  })

  it("'map' → warns (real gap, ground-plane projection deferred)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('map') as never, { coverage })
    const w = coverage.warnings.find(w => w.includes('icon-pitch-alignment'))
    expect(w).toBeDefined()
  })

  it("['literal', 'viewport'] → unwrapped + suppressed", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(['literal', 'viewport']) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-pitch-alignment'))).toBe(false)
  })

  it('omitted → no warning', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 's',
        type: 'symbol',
        source: 'v',
        'source-layer': 'p',
        layout: { 'icon-image': 'marker' },
      }],
    }
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(style as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-pitch-alignment'))).toBe(false)
  })
})
