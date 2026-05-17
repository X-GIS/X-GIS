// Pin loop unwrap on the exponential-base SCALAR inside the curve
// spec. Single-pass peel handled `['exponential', ['literal', 2]]`
// but missed `['exponential', ['literal', ['literal', 2]]]`. Both
// expressions.ts (generic interp) and paint.ts (zoom interp) had the
// gap.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('interpolate exponential base double-wrap', () => {
  it('zoom-driven double-wrapped base still emits interpolate_exp', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: {
            'line-color': '#000',
            'line-width': [
              'interpolate', ['exponential', ['literal', ['literal', 2]]], ['zoom'],
              5, 1,
              14, 8,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate_exp')
    expect(code).toContain(', 2,')
  })

  it('non-zoom double-wrapped base still emits interpolate_exp', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: {
            'circle-color': '#000',
            'circle-radius': [
              'interpolate', ['exponential', ['literal', ['literal', 1.5]]], ['get', 'mag'],
              0, 1,
              10, 50,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate_exp')
    expect(code).toContain('1.5')
  })
})
