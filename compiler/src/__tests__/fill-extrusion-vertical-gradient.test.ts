// fill-extrusion-vertical-gradient surface behaviour. Default is
// `true` per Mapbox spec, and X-GIS runtime always applies the
// gradient ramp — setting `true` is a no-op match and shouldn't
// emit a spurious "ignored property" warning. Setting `false` is
// a real gap (runtime can't disable the ramp yet) and DOES warn.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(value: unknown) {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'bldg',
      type: 'fill-extrusion',
      source: 'v',
      'source-layer': 'building',
      paint: {
        'fill-extrusion-color': '#aaa',
        'fill-extrusion-height': 10,
        'fill-extrusion-vertical-gradient': value,
      },
    }],
  }
}

describe('fill-extrusion-vertical-gradient surface', () => {
  it('omitted → no ignored-property warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const style = buildStyle(undefined)
    delete (style.layers[0]!.paint as Record<string, unknown>)['fill-extrusion-vertical-gradient']
    convertMapboxStyle(style as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
  })

  it('explicit true (spec default) → no warning, runtime applies default gradient', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(true) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
  })

  it('["literal", true] (v8 strict wrap) → no warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(['literal', true]) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
  })

  it('false → warns (real runtime gap)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(false) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(true)
  })

  it('null (spec: fall back to default) → no warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(null) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('vertical-gradient'))).toBe(false)
  })
})
