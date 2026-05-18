// Pin warning for math / string / length builtins called with the
// wrong arg count. Mapbox spec: abs / ceil / floor / round / sqrt /
// trig / log / length / downcase / upcase all take exactly 1 arg.
// Pre-fix a bare `["abs"]` (no operand) silently dropped via
// exprToXgis(undefined) → null with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('math builtin arity warnings', () => {
  it('["abs"] (no operand) warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-radius': ['abs'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["abs"\] expression: expected 1 argument, got 0/)
  })

  it('["sqrt", 4, 9] (extra operand) warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-radius': ['sqrt', 4, 9] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["sqrt"\] expression: expected 1 argument, got 2/)
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
          paint: { 'circle-radius': ['abs', ['get', 'm']] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Malformed \["abs"\]/)
  })
})
