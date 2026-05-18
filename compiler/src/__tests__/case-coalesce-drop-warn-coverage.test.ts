// Pin partial-drop warnings for `case` and `coalesce` expressions
// where individual arms / args fail to convert. Pre-fix the failed
// sub-expressions vanished silently — the ternary or fallback chain
// collapsed to the default for that condition with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('case / coalesce partial-drop warnings', () => {
  it('coalesce with one unsupported head warns about dropped arg', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            // `["image", …]` is unsupported by the converter — head drops.
            'fill-color': ['coalesce', ['image', 'icon-x'], '#abc'],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["coalesce"\] dropped/)
  })

  it('all-valid coalesce does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': ['coalesce', ['get', 'color'], '#abc'],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\["coalesce"\] dropped/)
  })

  it('case with one unsupported arm warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            // Arm 1 cond `["image", …]` fails — should warn.
            'fill-color': [
              'case',
              ['image', 'flag-x'], '#fff',
              ['==', ['get', 'kind'], 'park'], '#0f0',
              '#abc',
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["case"\] dropped/)
  })

  it('match with one unsupported arm warns (chained-ternary path)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            // input is `["concat", …]` so converter routes through
            // matchToTernary (complex non-field input). Arms drop
            // through chained ["case"] which already warns; the
            // assertion is just that SOME drop warning surfaces.
            'fill-color': [
              'match',
              ['get', 'kind'],
              'park', ['image', 'green-leaf'],
              'lake', '#00f',
              '#aaa',
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["match"\] dropped|\["case"\] dropped/)
  })

  it('all-valid case does NOT warn (regression guard)', () => {
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
              'case',
              ['==', ['get', 'kind'], 'park'], '#0f0',
              '#abc',
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\["case"\] dropped/)
  })
})
