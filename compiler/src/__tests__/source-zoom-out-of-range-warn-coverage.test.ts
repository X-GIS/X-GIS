// Pin out-of-range source-zoom warnings — mirror of the per-layer
// minzoom/maxzoom range check. Mapbox spec range is [0, 24]; tile
// selector silently clamps so a typo loses authored intent.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source zoom out-of-range', () => {
  it('negative source minzoom warns', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/v.pmtiles', minzoom: -1 },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Source "s" minzoom=-1 is outside Mapbox spec range/)
  })

  it('source maxzoom > 24 warns', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/v.pmtiles', maxzoom: 30 },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Source "s" maxzoom=30 is outside Mapbox spec range/)
  })

  it('boundary values 0 and 24 do NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/v.pmtiles', minzoom: 0, maxzoom: 24 },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/outside Mapbox spec range/)
  })
})
