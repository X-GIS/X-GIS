// Pin defensive try/catch around JSON.stringify on inline GeoJSON
// preview. A circular-reference data object (rare but possible from
// host code reusing live state) used to crash convertSource with a
// 'Converting circular structure to JSON' TypeError that propagated
// up and killed every other layer in the style.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('GeoJSON inline data circular reference', () => {
  it('circular data does not crash convertMapboxStyle', () => {
    const circular: Record<string, unknown> = { type: 'FeatureCollection' }
    circular.self = circular  // cycle
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: circular as unknown } },
      layers: [
        { id: 'l', type: 'fill', source: 's', paint: { 'fill-color': '#000' } },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    // The downstream layer still emits despite the bad source.
    expect(code).toContain('layer l')
    expect(code).toContain('unserialisable')
  })

  it('regression: well-formed inline data still serialises', () => {
    const style = {
      version: 8,
      sources: {
        s: {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } }] },
        },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('Point')
  })
})
