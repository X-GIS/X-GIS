// icon-overlap / icon-allow-overlap value-aware warnings.
// X-GIS allows icon overlap by default (no icon-side collision queue
// yet). Authors setting `always` / `true` match X-GIS — silent.
// Authors setting `never` / `cooperative` / `false` expect collision
// dedup that X-GIS doesn't deliver — warns explicitly so dense POI
// layer authors know about the gap.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(layout: Record<string, unknown>) {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'poi',
      type: 'symbol',
      source: 'v',
      'source-layer': 'poi',
      layout: { 'icon-image': 'marker', 'text-field': '{name}', ...layout },
    }],
  }
}

describe('icon-overlap / icon-allow-overlap value-aware warnings', () => {
  it("icon-overlap 'always' → silent (matches X-GIS default)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'icon-overlap': 'always' }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-overlap'))).toBe(false)
  })

  it("icon-overlap 'never' → warns (real runtime gap)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'icon-overlap': 'never' }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-overlap "never"'))).toBe(true)
  })

  it("icon-overlap 'cooperative' → warns (collision queue deferred)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'icon-overlap': 'cooperative' }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-overlap "cooperative"'))).toBe(true)
  })

  it('icon-allow-overlap: true → silent (matches default)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'icon-allow-overlap': true }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-allow-overlap'))).toBe(false)
  })

  it('icon-allow-overlap: false → warns (real runtime gap)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'icon-allow-overlap': false }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-allow-overlap: false'))).toBe(true)
  })

  it('icon-allow-overlap omitted → silent', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({}) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('icon-allow-overlap'))).toBe(false)
  })
})
