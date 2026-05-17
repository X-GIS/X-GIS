// Pin Mapbox v8 strict `["literal", N]` wrap unwrap on the
// exponential CURVE BASE inside interpolate(). Pre-fix the typeof
// check rejected the wrapped base, the curve silently fell back to
// linear, and the property animated on a straight ramp instead of
// the authored eased curve. Both modern interpolate-by-zoom (paint.ts)
// and the generic interpolate handler (expressions.ts) had the gap.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('interpolate exponential-base literal-wrap unwrap', () => {
  it('zoom-driven exponential base wrap still emits interpolate_exp', () => {
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
              'interpolate', ['exponential', ['literal', 2]], ['zoom'],
              5, 1,
              14, 8,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // Expected: exponential curve preserved (base 2).
    expect(code).toContain('interpolate_exp')
    expect(code).toContain(', 2,')  // base argument
  })

  it('non-zoom exponential base wrap (generic interpolate) still emits interpolate_exp', () => {
    // input = ["get", "magnitude"], routes through expressions.ts's
    // interpolate handler (not the paint.ts zoom-stops path).
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
              'interpolate', ['exponential', ['literal', 1.5]], ['get', 'magnitude'],
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

  it('bare exponential base still works (regression guard)', () => {
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
