// raster-resampling value-aware warning. 'linear' (default) matches
// X-GIS — no spurious warning. 'nearest' is a real gap (pixel-art /
// DEM staircase rendering) — warns explicitly.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(value: unknown) {
  const layer: Record<string, unknown> = {
    id: 'r',
    type: 'raster',
    source: 'r',
    paint: { 'raster-opacity': 1 },
  }
  if (value !== undefined) {
    (layer.paint as Record<string, unknown>)['raster-resampling'] = value
  }
  return {
    version: 8,
    sources: { r: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'] } },
    layers: [layer],
  }
}

describe('raster-resampling value-aware warning', () => {
  it('omitted → silent', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(undefined) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('raster-resampling'))).toBe(false)
  })

  it("'linear' (spec default) → silent (matches X-GIS sampler)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('linear') as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('raster-resampling'))).toBe(false)
  })

  it("'nearest' → warns (real runtime gap)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('nearest') as never, { coverage })
    const w = coverage.warnings.find(w => w.includes('raster-resampling: nearest'))
    expect(w).toBeDefined()
    expect(w).toContain('sampler is fixed to linear')
  })

  it("['literal', 'nearest'] → warns (v8 strict wrap honoured)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(['literal', 'nearest']) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('raster-resampling: nearest'))).toBe(true)
  })

  it("['literal', 'linear'] → silent (v8 strict wrap honoured)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(['literal', 'linear']) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('raster-resampling'))).toBe(false)
  })
})
