// Pin warning for ["literal"] with no inner value. Pre-fix the bare
// form silently fell through exprToXgis(undefined) → null at the
// bottom of the switch and the containing expression dropped with
// no specific diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('["literal"] missing payload warning', () => {
  it('bare ["literal"] warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['literal'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["literal"\] expression: missing inner value/)
  })

  it('well-formed ["literal", value] does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['literal', '#abc'] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Malformed \["literal"\]/)
  })
})
