// line-translate specific gap warning. fill-translate has a
// u.fill_translate_x/y uniform that the vertex shader applies;
// line-translate would mirror that via u.line_translate_x/y but
// the line renderer hasn't been wired yet (Plan §4 deferred).
// Surface the specific gap rather than the generic ignored-
// properties blob.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(extra: Record<string, unknown>) {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'road',
      type: 'line',
      source: 'v',
      'source-layer': 'r',
      paint: { 'line-color': '#fff', 'line-width': 1, ...extra },
    }],
  }
}

describe('line-translate surface', () => {
  it('omitted → no warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({}) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('line-translate'))).toBe(false)
  })

  it('set → specific gap warning (not the generic ignored-properties blob)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'line-translate': [2, -3] }) as never, { coverage })
    const w = coverage.warnings.find(w => w.includes('line-translate set but'))
    expect(w).toBeDefined()
    expect(w).toContain('u.fill_translate_x/y')
    expect(w).toContain('Plan §4')
    // Must NOT also appear in the generic ignored-properties blob.
    expect(coverage.warnings.some(w => w.includes('ignored paint properties') && w.includes('line-translate'))).toBe(false)
  })

  it('null → no warning (spec fallback)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'line-translate': null }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('line-translate'))).toBe(false)
  })
})
