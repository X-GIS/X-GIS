// Pin defensive coercion of malformed style.layers. Non-array forms
// (object, string, null) crashed the .find() call (no method on
// non-array) and the for...of loop (no iterator on plain object).
// Now coerced to [] when not array.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('style.layers non-array coercion', () => {
  it('object layers treated as empty array', () => {
    const style = { version: 8, sources: {}, layers: { a: 'oops' } as unknown }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('string layers treated as empty array', () => {
    const style = { version: 8, sources: {}, layers: 'oops' as unknown }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('null layers treated as empty array', () => {
    const style = { version: 8, sources: {}, layers: null as unknown }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('regression: valid layer array converts normally', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [{ id: 'a', type: 'fill', source: 's', paint: { 'fill-color': '#000' } }],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer a')
  })
})
