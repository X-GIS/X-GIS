// Pin multi-wrap null treatment on symbol text-field. Pre-fix
// `['literal', null]` (or deeper) was non-null so hasText stayed
// true → iconOnly stayed false → layer emitted both icon utilities
// AND a phantom `label-[null]` instead of going through the
// icon-only branch.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('symbol text-field multi-wrap null', () => {
  it('text-field = ["literal", null] + icon-image → icon-only path', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': ['literal', null] as unknown, 'icon-image': 'marker' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('label-icon-image-marker')
    expect(code).not.toContain('label-[null]')
  })

  it('text-field = ["literal", ["literal", null]] also routes icon-only', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': ['literal', ['literal', null]] as unknown,
            'icon-image': 'marker',
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('label-icon-image-marker')
    expect(code).not.toContain('label-[null]')
  })

  it('text-field = ["literal", null] + no icon → layer SKIPPED', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': ['literal', null] as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('SKIPPED layer "l"')
  })
})
