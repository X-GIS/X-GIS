// Pin arity warnings for ["at"], ["typeof"], ["slice"], ["index-of"].
// Pre-fix these silently returned null on wrong arity with no
// diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('array/typeof/slice/index-of arity warnings', () => {
  it('["at"] with one arg warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', paint: { 'fill-color': ['at', 0] } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["at"\] expression: expected 2 arguments/)
  })

  it('["typeof"] with no arg warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', filter: ['==', ['typeof'], 'string'], paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["typeof"\] expression: expected 1 argument/)
  })

  it('["slice"] with one arg warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'symbol', source: 's', layout: { 'text-field': ['slice', ['get', 'name']] } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["slice"\] expression: expected 2-3 arguments/)
  })

  it('["index-of"] with one arg warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', paint: { 'fill-color': ['*', 0, ['index-of', 'x']] } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["index-of"\] expression: expected 2-3 arguments/)
  })

  it('correct arity does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['at', 0, ['literal', ['#abc']]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Malformed \["at"\]/)
  })
})
