// Pin `pmtiles://` strip across ALL source-type branches.
// Pre-fix the strip only fired in the `type:vector` branch (1ffd4eb);
// explicit `type:pmtiles` / `type:raster` etc. carrying the scheme
// prefix still emitted the bad URL.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('pmtiles:// prefix strip across source types', () => {
  it('explicit type:pmtiles strips prefix', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'pmtiles', url: 'pmtiles://https://example.com/x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('url: "https://example.com/x.pmtiles"')
    expect(code).not.toContain('pmtiles://')
  })

  it('explicit type:tilejson strips prefix', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'tilejson', url: 'pmtiles://https://example.com/tiles.json' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('url: "https://example.com/tiles.json"')
    expect(code).not.toContain('pmtiles://')
  })

  it('type:raster tiles[0] strips prefix', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['pmtiles://https://example.com/{z}/{x}/{y}.png'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('url: "https://example.com/{z}/{x}/{y}.png"')
    expect(code).not.toContain('pmtiles://')
  })
})
