// Pin remaining loop-unwrap conversions: has/!has field, to-color
// inner, expand-color-match defaultOut + vals + out, interpolate
// curveSpec (both files), addStrokeDash outer. Each was single-pass.

import { describe, it, expect } from 'vitest'
import { filterToXgis, exprToXgis } from '../convert/expressions'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { colorToXgis } from '../convert/colors'

describe('converter final wrap cleanup', () => {
  it('has doubly-wrapped field still emits .field != null', () => {
    const w: string[] = []
    const out = filterToXgis(['has', ['literal', ['literal', 'name']]], w)
    expect(out).toBe('.name != null')
  })

  it('!has doubly-wrapped field still emits .field == null', () => {
    const w: string[] = []
    const out = filterToXgis(['!has', ['literal', ['literal', 'name']]], w)
    expect(out).toBe('.name == null')
  })

  it('to-color doubly-wrapped inner string still hex-encodes', () => {
    const w: string[] = []
    const out = colorToXgis(['to-color', ['literal', ['literal', '#abc']]], w)
    expect(out).toBe('#abc')
  })

  it('expand-color-match doubly-wrapped defaultOut still produces fallback layer', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'pmtiles://x.pmtiles' } },
      layers: [
        {
          id: 'countries',
          type: 'fill',
          source: 's',
          'source-layer': 'country',
          paint: {
            'fill-color': ['match', ['get', 'code'],
              'us', '#f00',
              'cn', '#0f0',
              'jp', '#00f',
              ['literal', ['literal', '#eee']],
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // Default arm should pick up #eee — expand-color-match splits into
    // one layer per unique colour plus a fallback __cd layer.
    expect(code).toContain('countries__cd')
    expect(code).toContain('fill-#eee')
  })

  it('interpolate curveSpec doubly-wrapped still emits interpolate_exp', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate', ['literal', ['literal', ['exponential', 2]]], ['zoom'], 5, 1, 14, 8],
      w,
    )
    expect(out).toContain('interpolate_exp(zoom, 2,')
  })

  it('line-dasharray doubly-wrapped outer still emits dash', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': '#000', 'line-dasharray': ['literal', ['literal', [4, 2]]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-dasharray-4-2')
  })
})
