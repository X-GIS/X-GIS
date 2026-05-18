// Pin warning surface for expand-color-match bail paths when the
// match LOOKS like a per-feature colour palette but a structural
// problem prevents the split. Pre-fix the layer silently fell to
// lower.ts's pick-first-stop fallback and the author had no idea
// why an 8-country palette collapsed to one colour.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('expand-color-match bail warnings', () => {
  it('non-string default arm warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': [
              'match',
              ['get', 'iso'],
              'US', '#abc',
              'CA', '#def',
              ['get', 'fallback'], // non-string default — expression
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/match default arm is not a constant colour string/)
  })

  it('non-string arm output warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': [
              'match',
              ['get', 'iso'],
              'US', ['get', 'color'], // arm value is expression, not constant
              'CA', '#def',
              '#fallback',
            ],
          },
        },
      ],
    }
    // Need a valid default for this test — `#fallback` isn't a real
    // hex but the convert path doesn't validate THIS test's bail
    // happens on the arm, not the default.
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/match arm output is not a constant colour string/)
  })

  it('well-formed match does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': [
              'match',
              ['get', 'iso'],
              'US', '#abc',
              'CA', '#def',
              'MX', '#456',
              '#000',
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/per-feature colour expand bailed/)
  })
})
