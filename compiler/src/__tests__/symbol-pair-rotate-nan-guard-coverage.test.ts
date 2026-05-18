// Pin NaN/Infinity rejection at symbol layer pair-scalar emit sites:
// text-rotate, text-letter-spacing, text-offset, text-translate,
// text-variable-anchor-offset (vao). Pre-fix `!== 0` lets NaN
// through (NaN !== 0 is true); the emitted utility `label-rotate-NaN`
// / `label-offset-x-NaN` / etc. was lex-rejected.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('symbol pair-scalar NaN guard', () => {
  it('NaN text-rotate does not emit NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}', 'text-rotate': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/label-rotate-NaN/)
  })

  it('NaN text-letter-spacing does not emit NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}', 'text-letter-spacing': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/label-letter-spacing-NaN/)
  })

  it('NaN in text-offset pair does not emit NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}', 'text-offset': [NaN, 2] as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/label-offset-x-NaN/)
  })

  it('miter-limit NaN does not emit NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          layout: { 'line-miter-limit': NaN as unknown },
          paint: { 'line-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/stroke-miterlimit-NaN/)
  })
})
