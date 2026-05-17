// Pin defensive coercion of non-object layer.paint / layer.layout.
// Mapbox spec requires objects but malformed JSON or copy-paste
// errors can yield strings, arrays, etc. Pre-fix `paint['fill-color']`
// indexed a char of the string or undefined of the array → garbage
// utility values + occasional crashes.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer.paint non-object coercion', () => {
  it('string paint treated as empty object', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', paint: 'oops' as unknown },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer l')
    // No char-index leakage like `fill-o`.
    expect(code).not.toMatch(/fill-[a-z]\b/)
  })

  it('array paint treated as empty object', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', paint: ['oops'] as unknown },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('null paint still works (treats as omitted)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', paint: null as unknown },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('regression: valid object paint still emits utilities', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', paint: { 'fill-color': '#f00' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('fill-#f00')
  })
})
