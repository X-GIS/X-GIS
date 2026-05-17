// Pin defensive guard for null / non-object layer entries.
// Pre-fix the converter accessed `layer.type` on null and threw —
// the WHOLE convertMapboxStyle call failed and every valid layer
// past the bad entry dropped.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer null entry guard', () => {
  it('null layer entry does not crash; subsequent layers still convert', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        null as unknown,
        { id: 'good', type: 'fill', source: 's', paint: { 'fill-color': '#000' } },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer good')
    expect(code).toContain('fill-#000')
  })

  it('null entry in bg-search position does not crash', () => {
    // The `find(l => l.type === 'background')` previously crashed on
    // the null entry before even reaching the layer loop.
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        null as unknown,
        { id: 'l', type: 'line', source: 's', paint: { 'line-color': '#000' } },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('regression: valid layer array converts normally', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'a', type: 'fill', source: 's', paint: { 'fill-color': '#f00' } },
        { id: 'b', type: 'line', source: 's', paint: { 'line-color': '#0f0' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer a')
    expect(code).toContain('layer b')
  })
})
