// Pin NaN/Infinity rejection in paint property interpolate-zoom
// callbacks. Pre-fix `typeof NaN === 'number'` slipped past the
// type gate; `Math.max(0, NaN)` propagated NaN; the emitted stop
// was `String(NaN)` = `"NaN"` which the runtime number-parser
// rejected, silently dropping the entire interpolate stops list.
// Affected: stroke-width / extrude-height / extrude-base /
// text-size / text-halo-width / text-padding / circle-radius /
// circle-stroke-width.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('paint interp-zoom NaN/Infinity rejection', () => {
  it('NaN stop in line-width interp does not emit NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: {
            'line-color': '#abc',
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              5, NaN as unknown,
              10, 3,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // "NaN" can appear inside the warning text body — the assertion
    // is that no UTILITY emits with NaN inside a bracket binding.
    expect(code).not.toMatch(/\[interpolate\([^\]]*NaN[^\]]*\)\]/)
    expect(code).not.toMatch(/stroke-NaN/)
    expect(code).not.toMatch(/size-NaN/)
  })

  it('NaN stop in text-size interp does not emit NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': '{name}',
            'text-size': [
              'interpolate', ['linear'], ['zoom'],
              5, 12,
              10, NaN as unknown,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // "NaN" can appear inside the warning text body — the assertion
    // is that no UTILITY emits with NaN inside a bracket binding.
    expect(code).not.toMatch(/\[interpolate\([^\]]*NaN[^\]]*\)\]/)
    expect(code).not.toMatch(/stroke-NaN/)
    expect(code).not.toMatch(/size-NaN/)
  })

  it('Infinity stop in circle-radius interp does not emit Infinity', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: {
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              5, 3,
              10, Infinity as unknown,
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\[interpolate\([^\]]*Infinity[^\]]*\)\]/)
    expect(code).not.toMatch(/size-Infinity/)
  })
})
