// Pin warning when a let binding name is not a string. Pre-fix the
// invalid binding silently bailed; the body of the let evaluated
// against an empty bindings map and ["var", name] references all
// resolved to null with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('let binding-name validation', () => {
  it('non-string binding name warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': ['let', 42, '#abc', ['var', 'foo']],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["let"\] expression: binding name at slot 0 is number/)
  })

  it('valid string binding does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': ['let', 'c', '#abc', ['var', 'c']],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Malformed \["let"\] expression: binding name/)
  })
})
