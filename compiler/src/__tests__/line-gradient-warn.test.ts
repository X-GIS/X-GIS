// line-gradient surface — the property requires the line-progress
// accessor + per-fragment arc-length varying which isn't implemented.
// Mapbox documents this as a paint property used for hill / route
// gradient rendering (e.g. mountain trail elevation profiles).
//
// Surface as a SPECIFIC warning (not the generic ignored-properties
// blob) so authors know what would be needed to close the gap.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(extra: Record<string, unknown>) {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'route',
      type: 'line',
      source: 'v',
      'source-layer': 'routes',
      paint: {
        'line-color': '#ff0000',
        'line-width': 3,
        ...extra,
      },
    }],
  }
}

describe('line-gradient surface', () => {
  it('omitted → no warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({}) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('line-gradient'))).toBe(false)
  })

  it('set → specific gap warning (not the generic ignored-properties blob)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(
      buildStyle({
        'line-gradient': [
          'interpolate', ['linear'], ['line-progress'],
          0, '#ff0000', 1, '#0000ff',
        ],
      }) as never,
      { coverage },
    )
    const w = coverage.warnings.find(w => w.includes('line-gradient'))
    expect(w).toBeDefined()
    expect(w).toContain('line-progress accessor')
    expect(w).toContain('Plan §4')
    // Must NOT appear in the generic ignored-properties blob too.
    const genericMention = coverage.warnings.find(w => w.includes('ignored paint properties') && w.includes('line-gradient'))
    expect(genericMention).toBeUndefined()
  })

  it('null → no warning (spec fallback)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'line-gradient': null }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('line-gradient'))).toBe(false)
  })
})
