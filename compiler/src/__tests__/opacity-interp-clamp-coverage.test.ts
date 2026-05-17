// Pin Mapbox opacity ∈ [0, 1] clamp inside the addOpacity interp
// callback. Pre-fix the constant path clamped but the zoom-stops
// callback didn't — a negative stop emitted opacity-[..., -50, ...]
// (invalid utility name; the parser splits on the embedded -) and
// an out-of-range > 1 stop emitted a percentage > 100, both diverge
// from MapLibre's spec-enforced clamp.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('addOpacity interp-callback clamp', () => {
  it('negative zoom stop clamps to 0 (not -50)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': '#000',
            'fill-opacity': [
              'interpolate', ['linear'], ['zoom'],
              5, -0.5,
              14, 1,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // Negative value should clamp to 0 — no `-50` substring in the
    // emitted interp.
    expect(code).not.toContain(', -50,')
    expect(code).toContain('interpolate(zoom, 5, 0, 14, 100)')
  })

  it('utility-scale zoom stop > 1 (xgis convention 0..100) clamps + scales correctly', () => {
    // The dual-interp `val <= 1 ? val : val / 100` accepts BOTH Mapbox-
    // style 0..1 AND xgis-style 0..100 in the same property. A stop
    // value of 100 means "fully opaque" in xgis convention; pre-fix
    // the interp callback emitted raw "100" but the constant path
    // already did. Mirror so the interp output matches.
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': '#000',
            'fill-opacity': [
              'interpolate', ['linear'], ['zoom'],
              5, 50,
              14, 100,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate(zoom, 5, 50, 14, 100)')
  })

  it('in-range zoom stops still scale correctly (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': '#000',
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.25, 14, 0.75],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('interpolate(zoom, 5, 25, 14, 75)')
  })
})
