// Pin unwrapLiteralScalar null pass-through. Pre-fix the scalar-type
// gate (`typeof === 'number' | 'string' | 'boolean'`) rejected null,
// so ['literal', null] / ['literal', ['literal', null]] stayed as
// outer arrays and downstream `!== null` gates fired on the wrapper
// → emitted utilities with the null binding instead of falling to
// the spec default.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('unwrapLiteralScalar peels wrapped null', () => {
  it('text-size = ["literal", null] falls to spec default 16', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}', 'text-size': ['literal', null] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('label-size-[null]')
    expect(code).toContain('label-size-16')
  })

  it('text-padding = ["literal", ["literal", null]] silently drops', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}', 'text-padding': ['literal', ['literal', null]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('label-padding-[null]')
  })

  it('circle-radius = ["literal", null] falls to spec default 5', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-radius': ['literal', null], 'circle-color': '#000' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('size-[null]')
    expect(code).toContain('size-5')
  })
})
