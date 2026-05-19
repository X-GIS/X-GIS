// surfaceIgnoredPaint() aggregates ALL ignored properties per layer
// into a SINGLE warning. Pre-aggregation iter would emit N warnings
// for N ignored properties; that drowns the per-layer signal-to-
// noise in dense styles (OFM Liberty has ~30 line layers, each with
// 2-3 ignored properties = ~70 spam warnings without aggregation).

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('surfaceIgnoredPaint aggregation', () => {
  it('multiple ignored line properties → single warning per layer', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'l',
        type: 'line',
        source: 'v',
        'source-layer': 'r',
        paint: {
          'line-color': '#fff',
          'line-translate-anchor': 'viewport',
          'line-sort-key': 5,
          'line-round-limit': 1.5,
        },
      }],
    } as never, { coverage })

    const layerWarns = coverage.warnings.filter(w => w.includes('ignored paint properties'))
    // The anchor-parent dependency check suppresses
    // line-translate-anchor (parent line-translate is absent), so
    // only the OTHER two ignored properties surface. Aggregation
    // contract still holds: 1 warning total naming both.
    expect(layerWarns.length).toBe(1)
    expect(layerWarns[0]).toContain('line-sort-key')
    expect(layerWarns[0]).toContain('line-round-limit')
  })

  it('multiple layers each get their own aggregated warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        { id: 'a', type: 'line', source: 'v', 'source-layer': 'r', paint: { 'line-color': '#fff', 'line-sort-key': 1 } },
        { id: 'b', type: 'line', source: 'v', 'source-layer': 'r', paint: { 'line-color': '#fff', 'line-sort-key': 1 } },
      ],
    } as never, { coverage })

    const layerWarns = coverage.warnings.filter(w => w.includes('ignored paint properties'))
    expect(layerWarns.length).toBe(2)
    expect(layerWarns.some(w => w.includes('"a"'))).toBe(true)
    expect(layerWarns.some(w => w.includes('"b"'))).toBe(true)
  })

  it('null-valued ignored property → no warning (spec fallback semantics)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'l',
        type: 'line',
        source: 'v',
        'source-layer': 'r',
        paint: {
          'line-color': '#fff',
          'line-translate-anchor': null,
          'line-sort-key': null,
        },
      }],
    } as never, { coverage })

    expect(coverage.warnings.some(w => w.includes('ignored paint properties'))).toBe(false)
  })
})
