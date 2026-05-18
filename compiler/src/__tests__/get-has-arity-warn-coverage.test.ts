// Pin arity warnings for ["get"], ["has"], ["!has"]. Pre-fix a bare
// ["get"] / ["has"] (no field-name arg) silently dropped through
// exprToXgis(undefined) → null with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('get / has / !has arity warnings', () => {
  it('["get"] (no field) warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['get'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["get"\] expression: missing field name argument/)
  })

  it('["has"] (no field) warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          filter: ['has'],
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["has"\] expression/)
  })

  it('["!has"] (no field) warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          filter: ['!has'],
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["!has"\] expression/)
  })

  it('correct get/has arity does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          filter: ['has', 'name'],
          paint: { 'fill-color': ['get', 'color'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Malformed \["get"\]/)
    expect(code).not.toMatch(/Malformed \["has"\]/)
  })
})
