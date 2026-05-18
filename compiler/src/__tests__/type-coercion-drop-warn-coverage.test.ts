// Pin partial-drop warning for Mapbox type-coercion expressions
// (to-number / to-string / to-boolean / to-color / number / string
// / boolean) when one fallback arg fails to convert. Mirror of the
// case/coalesce/match partial-drop warnings.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('type-coercion partial-drop warnings', () => {
  it('to-number with unsupported head warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill-extrusion',
          source: 's',
          paint: {
            // ["image", …] is unsupported, falls back to 50.
            'fill-extrusion-height': ['to-number', ['image', 'h'], 50],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["to-number"\] dropped/)
  })

  it('all-valid to-string does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': ['to-string', ['get', 'name'], 'unnamed'],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\["to-string"\] dropped/)
  })
})
