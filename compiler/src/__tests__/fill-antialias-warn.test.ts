// fill-antialias surface behaviour. Default `true` matches X-GIS
// runtime (always anti-aliases edges) → no spurious warning when
// authored explicitly. `false` is a real gap (X-GIS can't disable
// edge AA per layer yet) → warns explicitly so pixel-art landcover
// authors know why their land looks soft.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(value: unknown) {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'land',
      type: 'fill',
      source: 'v',
      'source-layer': 'land',
      paint: {
        'fill-color': '#ddd',
        'fill-antialias': value,
      },
    }],
  }
}

describe('fill-antialias surface behaviour', () => {
  it('omitted → no warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const style = buildStyle(undefined)
    delete (style.layers[0]!.paint as Record<string, unknown>)['fill-antialias']
    convertMapboxStyle(style as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('fill-antialias'))).toBe(false)
  })

  it('explicit true (spec default) → no warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(true) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('fill-antialias'))).toBe(false)
  })

  it('["literal", true] → no warning (v8 strict wrap)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(['literal', true]) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('fill-antialias'))).toBe(false)
  })

  it('false → warns (real runtime gap)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(false) as never, { coverage })
    const w = coverage.warnings.find(w => w.includes('fill-antialias false'))
    expect(w).toBeDefined()
    expect(w).toContain("can't disable edge AA")
  })

  it('["literal", false] → warns (v8 strict wrap honoured)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle(['literal', false]) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('fill-antialias false'))).toBe(true)
  })
})
