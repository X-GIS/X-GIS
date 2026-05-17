// Pin Mapbox v8 strict `["literal", N]` wrap unwrap on zoom KEYS
// inside parseSymbolPlacementStep. Pre-fix wrapped keys failed the
// typeof === 'number' gate, the parser returned null, the step
// expansion collapsed to a single fallback layer with the default
// placement, and the layer lost its zoom-driven point/line-center
// split (typical OFM Bright road-shield pattern).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('symbol-placement step zoom-key literal-wrap unwrap', () => {
  it('wrapped zoom keys still expand into multiple xgis layer blocks', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'road-shield',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': '{ref}',
            'symbol-placement': [
              'step', ['zoom'],
              'point',
              ['literal', 12], 'line',
              ['literal', 16], 'line-center',
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // Step expanded → at least 3 layer blocks (one per segment).
    const layerCount = (code.match(/^layer /gm) ?? []).length
    expect(layerCount).toBeGreaterThanOrEqual(3)
    expect(code).toContain('label-along-path')
    expect(code).toContain('label-line-center')
  })

  it('bare zoom keys still expand (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'road-shield',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': '{ref}',
            'symbol-placement': ['step', ['zoom'], 'point', 12, 'line', 16, 'line-center'],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    const layerCount = (code.match(/^layer /gm) ?? []).length
    expect(layerCount).toBeGreaterThanOrEqual(3)
  })
})
