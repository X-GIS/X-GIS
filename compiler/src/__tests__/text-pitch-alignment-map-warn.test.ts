// text-pitch-alignment: map runtime gap surface.
// Compiler still emits the alignment utility; the WARNING surfaces
// to the user that the runtime won't actually project labels onto
// the ground plane. Plan §3.1 deferred runtime work.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(pitchAlign: string) {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'labels',
      type: 'symbol',
      source: 'v',
      'source-layer': 'poi',
      layout: {
        'text-field': '{name}',
        'text-pitch-alignment': pitchAlign,
      },
    }],
  }
}

describe('text-pitch-alignment runtime-gap warning', () => {
  it('map mode warns that runtime renders labels viewport-aligned regardless', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('map') as never, { coverage })
    const w = coverage.warnings.find(w => w.includes('text-pitch-alignment "map"'))
    expect(w).toBeDefined()
    expect(w).toContain('ground-projection not yet implemented')
  })

  it('viewport mode does NOT warn (no runtime gap there)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('viewport') as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('text-pitch-alignment "map"'))).toBe(false)
  })

  it('auto mode does NOT warn (auto resolves to viewport in current runtime)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('auto') as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('text-pitch-alignment "map"'))).toBe(false)
  })

  it('invalid enum still warns with the existing enum-validation message', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('horizontal') as never, { coverage })
    const w = coverage.warnings.find(w => w.includes('is not a valid enum'))
    expect(w).toBeDefined()
  })
})
