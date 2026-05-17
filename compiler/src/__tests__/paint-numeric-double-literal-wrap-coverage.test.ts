// Pin multi-level literal-wrap unwrap on numeric paint helpers
// (unwrapStopLiteral, unwrapLiteralNumeric in paint.ts, and
// unwrapLiteralScalar / unwrapLiteralTuple in layers.ts). v8 strict
// preprocessor chains can produce `["literal", ["literal", v]]`;
// pre-fix the single-pass unwrap left the inner wrapper intact and
// the typeof === 'number' gate failed → property fell to default.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('paint numeric double-literal-wrap unwrap', () => {
  it('fill-opacity double-wrap still emits constant opacity utility', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: {
            'fill-color': '#000',
            'fill-opacity': ['literal', ['literal', 0.5]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('opacity-50')
  })

  it('line-width double-wrap still emits constant stroke utility', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: {
            'line-color': '#000',
            'line-width': ['literal', ['literal', 3]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-3')
  })

  it('text-size double-wrap (unwrapLiteralScalar) still emits constant utility', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}', 'text-size': ['literal', ['literal', 18]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('label-size-18')
  })

  it('text-offset double-wrap (unwrapLiteralTuple) still emits offset utility', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}', 'text-offset': ['literal', ['literal', [0, -1.5]]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('label-offset-y-[-1.5]')
  })

  it('single-wrap still works (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: { 'line-color': '#000', 'line-width': ['literal', 3] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-3')
  })
})
