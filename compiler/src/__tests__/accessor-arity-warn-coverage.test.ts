// Pin arity warnings for zero-arg Mapbox accessors zoom /
// geometry-type / id and the number-format builtin. Pre-fix extra
// args were silently dropped (`["zoom", 1]` → just zoom) with no
// diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('zero-arg accessor + number-format arity warnings', () => {
  it('["zoom", 1] (extra arg) warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'circle', source: 's', paint: { 'circle-radius': ['+', 0, ['zoom', 1]] } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["zoom"\] expression/)
  })

  it('["geometry-type", 1] warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', filter: ['==', ['geometry-type', 1], 'Polygon'], paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["geometry-type"\] expression/)
  })

  it('["id", 1] warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', filter: ['==', ['id', 1], 1], paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["id"\] expression/)
  })

  it('["number-format"] with one arg warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'symbol', source: 's', layout: { 'text-field': ['number-format', 42] } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["number-format"\] expression/)
  })

  it('correct arity does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-radius': ['+', ['zoom'], 0] },
          filter: ['==', ['geometry-type'], 'Polygon'],
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Malformed \["zoom"\]/)
    expect(code).not.toMatch(/Malformed \["geometry-type"\]/)
  })
})
