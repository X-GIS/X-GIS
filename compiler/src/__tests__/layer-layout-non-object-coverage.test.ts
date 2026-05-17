// Pin defensive coercion of non-object layer.layout. Mirror of the
// paint guard (c9c97b1). A string / array layout value previously let
// `layout["text-field"]` index a char of the string or undefined of
// the array → garbage label expressions + crashes.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer.layout non-object coercion', () => {
  it('string layout treated as empty object', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: 'oops' as unknown,
          paint: { 'text-color': '#000' },
        },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    // No char-indexed text-field leakage.
    expect(code).not.toMatch(/label-\[\.o\]/)
  })

  it('array layout treated as empty object', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: ['oops'] as unknown,
        },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('null layout still works', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          layout: null as unknown,
          paint: { 'fill-color': '#000' },
        },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('fill-#000')
  })

  it('regression: valid layout still works', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('label-[.name]')
  })
})
