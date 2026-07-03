// raster-resampling is now SUPPORTED end-to-end (Phase S Batch 3): 'linear'
// (default) keeps the linear sampler, 'nearest' emits the
// `raster-resampling-nearest` utility the runtime maps to a nearest-filtered
// GPUSampler. Neither value warns; only an UNRECOGNISED value does.

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
    ;(layer.paint as Record<string, unknown>)['raster-resampling'] = value
  }
  return {
    version: 8,
    sources: { r: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'] } },
    layers: [layer],
  }
}

describe('raster-resampling converter emit', () => {
  it('omitted → silent, no utility', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const xgis = convertMapboxStyle(buildStyle(undefined) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('raster-resampling'))).toBe(false)
    expect(xgis).not.toContain('raster-resampling-nearest')
  })

  it("'linear' (spec default) → silent, no nearest utility", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const xgis = convertMapboxStyle(buildStyle('linear') as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('raster-resampling'))).toBe(false)
    expect(xgis).not.toContain('raster-resampling-nearest')
  })

  it("'nearest' → emits raster-resampling-nearest, no warn", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const xgis = convertMapboxStyle(buildStyle('nearest') as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('raster-resampling'))).toBe(false)
    expect(xgis).toContain('raster-resampling-nearest')
  })

  it("['literal', 'nearest'] → emits utility (v8 strict wrap honoured)", () => {
    const xgis = convertMapboxStyle(buildStyle(['literal', 'nearest']) as never)
    expect(xgis).toContain('raster-resampling-nearest')
  })

  it("['literal', 'linear'] → silent (v8 strict wrap honoured)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const xgis = convertMapboxStyle(buildStyle(['literal', 'linear']) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('raster-resampling'))).toBe(false)
    expect(xgis).not.toContain('raster-resampling-nearest')
  })

  it('unrecognised value → warns, treated as linear', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const xgis = convertMapboxStyle(buildStyle('bilinear') as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('raster-resampling'))).toBe(true)
    expect(xgis).not.toContain('raster-resampling-nearest')
  })
})
