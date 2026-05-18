// Pin warning when layer minzoom / maxzoom falls outside Mapbox spec
// range [0, 24]. Pre-fix an out-of-range value silently clamped at
// the tile selector with no diagnostic — the authored intent (often
// a typo) was lost.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer zoom out-of-range', () => {
  it('negative minzoom warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', minzoom: -2, paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/minzoom=-2 is outside Mapbox spec range/)
  })

  it('maxzoom > 24 warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'l', type: 'fill', source: 's', maxzoom: 30, paint: { 'fill-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/maxzoom=30 is outside Mapbox spec range/)
  })

  it('normal range does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          minzoom: 5,
          maxzoom: 18,
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/outside Mapbox spec range/)
  })

  it('boundary values 0 and 24 do NOT warn', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          minzoom: 0,
          maxzoom: 24,
          paint: { 'fill-color': '#abc' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/outside Mapbox spec range/)
  })
})
