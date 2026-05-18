// Pin arity + partial-drop warnings for ["min"] / ["max"]. Pre-fix
// `["min"]` (zero args) returned null silently; `["min", x, ["image",
// "y"]]` with unsupported head silently dropped to just min(x).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('min/max arity + partial-drop warnings', () => {
  it('["min"] (zero args) warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'circle', source: 's', paint: { 'circle-radius': ['min'] } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["min"\] expression/)
  })

  it('partial-drop in min warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          // ["image", …] is unsupported, drops; min still emits with one arg.
          paint: { 'circle-radius': ['min', 5, ['image', 'icon']] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["min"\] dropped 1 of 2 arg/)
  })

  it('all-valid max does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'circle', source: 's', paint: { 'circle-radius': ['max', 1, 2, 3] } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\["max"\] dropped/)
    expect(code).not.toMatch(/Malformed \["max"\]/)
  })
})
