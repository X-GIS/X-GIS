// Pin Mapbox v8 strict `["literal", N]` wrap unwrap on zoom KEYS
// inside interpolate-by-zoom expressions. Pre-fix the typeof check
// rejected the wrapped key, the whole interpolate returned null,
// and the property fell to its default (e.g. line-width snapping
// to 1px regardless of zoom).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('interpolate-zoom key literal-wrap unwrap', () => {
  it('wrapped zoom keys on line-width still emit zoom-stops', () => {
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
              'interpolate', ['linear'], ['zoom'],
              ['literal', 5], 1,
              ['literal', 14], 8,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate(zoom, 5, 1, 14, 8)')
  })

  it('legacy stops with wrapped zoom keys still emit zoom-stops', () => {
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
            'line-width': {
              stops: [
                [['literal', 5], 1],
                [['literal', 14], 8],
              ],
            },
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate(zoom, 5, 1, 14, 8)')
  })

  it('bare zoom keys still work (regression guard)', () => {
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
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 14, 8],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate(zoom, 5, 1, 14, 8)')
  })
})
