// Pin warning emission for malformed `interpolate` with odd stop-arg
// count. Pre-fix the trailing unpaired value silently disappeared; a
// hand-edited style that dropped a `y` value lost the transition with
// no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('interpolate odd stop-args warning', () => {
  it('odd trailing stop emits warning', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            // missing trailing y for the x=10 stop
            'fill-opacity': ['interpolate', ['linear'], ['get', 'm'], 0, 0.1, 10],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/odd number of stop arguments/)
  })

  it('even stops emit no parity warning (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-opacity': ['interpolate', ['linear'], ['get', 'm'], 0, 0.1, 10, 0.9],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/odd number of stop arguments/)
  })
})
