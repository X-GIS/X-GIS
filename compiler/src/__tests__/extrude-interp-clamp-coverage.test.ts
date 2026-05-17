// Pin Mapbox spec clamp (>= 0) inside addExtrudeHeight + addExtrudeBase
// interp callbacks. Pre-fix the constant path clamped but the
// zoom-stops callback passed numeric stops verbatim through
// exprToXgis, so a negative stop landed in interpolate(...) and the
// wall renderer received a negative height.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('fill-extrusion-height/base interp-callback clamp', () => {
  it('negative height stop clamps to 0', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill-extrusion',
          source: 's',
          paint: {
            'fill-extrusion-color': '#000',
            'fill-extrusion-height': [
              'interpolate', ['linear'], ['zoom'],
              5, -50,
              14, 200,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate(zoom, 5, 0, 14, 200)')
    expect(code).not.toContain(', -50,')
  })

  it('negative base stop clamps to 0', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill-extrusion',
          source: 's',
          paint: {
            'fill-extrusion-color': '#000',
            'fill-extrusion-base': [
              'interpolate', ['linear'], ['zoom'],
              5, -10,
              14, 100,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate(zoom, 5, 0, 14, 100)')
    expect(code).not.toContain(', -10,')
  })

  it('non-negative height stops still emit verbatim (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill-extrusion',
          source: 's',
          paint: {
            'fill-extrusion-color': '#000',
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 5, 5, 14, 200],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate(zoom, 5, 5, 14, 200)')
  })
})
