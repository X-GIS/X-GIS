// Pin NaN/Infinity rejection at constant-numeric paint emit sites.
// Pre-fix `typeof NaN === 'number'` slipped past the type gate;
// Math.max(0, NaN) = NaN; emitted utility was `label-size-NaN`,
// `stroke-NaN`, `size-NaN`, etc. — all lex-rejected.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('constant-numeric paint NaN/Infinity guards', () => {
  it('constant NaN line-width is rejected', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': '#abc', 'line-width': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/stroke-NaN/)
  })

  it('constant NaN text-size is rejected', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}', 'text-size': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/label-size-NaN/)
  })

  it('constant Infinity circle-radius is rejected', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-radius': Infinity as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/size-Infinity/)
  })

  it('valid finite constants emit (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': '#abc', 'line-width': 3 },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-3')
  })
})
