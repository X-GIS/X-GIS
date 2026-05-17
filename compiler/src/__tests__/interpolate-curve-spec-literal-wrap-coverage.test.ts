// Pin Mapbox v8 strict `["literal", curveSpec]` wrap unwrap on the
// interpolate CURVE SPEC. Pre-fix the wrapped form left
// curveSpec[0] === 'literal' (not 'exponential' / 'cubic-bezier'),
// so the curve recognition fell through and the authored exponential
// or bezier curve silently collapsed to linear interpolation.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('interpolate curve-spec literal-wrap unwrap', () => {
  it('wrapped exponential curve on zoom-driven interp emits interpolate_exp', () => {
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
              'interpolate', ['literal', ['exponential', 2]], ['zoom'],
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

  it('wrapped exponential curve on non-zoom interp emits interpolate_exp', () => {
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
              'interpolate', ['literal', ['exponential', 1.8]], ['get', 'magnitude'],
              0, 1,
              10, 50,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate_exp')
    expect(code).toContain('1.8')
  })

  it('bare exponential curve still works (regression guard)', () => {
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
            'line-width': ['interpolate', ['exponential', 2], ['zoom'], 5, 1, 14, 8],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate_exp')
  })
})
