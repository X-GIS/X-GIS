// Pin PMTiles URL scheme + extension detection as case-insensitive
// per RFC 3986 §3.1 ("schemes are case-insensitive"). Pre-fix
// `startsWith('pmtiles://')` and `/\.pmtiles/` (no `i` flag) rejected
// `PMTILES://...` / `.PMTILES` URLs — valid URIs that fell through to
// fetch on the made-up scheme (400) or routed through TileJSON (Wrong
// magic number on the archive bytes).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('PMTiles URL detection is case-insensitive', () => {
  it('uppercase PMTILES:// scheme prefix strips', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'PMTILES://https://example.com/x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
    expect(code).toContain('url: "https://example.com/x.pmtiles"')
    expect(code).not.toMatch(/pmtiles:\/\//i)
  })

  it('mixed-case Pmtiles:// scheme prefix strips', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'Pmtiles://https://example.com/x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
    expect(code).not.toMatch(/pmtiles:\/\//i)
  })

  it('uppercase .PMTILES extension routes to pmtiles', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/x.PMTILES' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
    expect(code).not.toContain('type: tilejson')
  })

  it('uppercase .PMTILES with fragment routes to pmtiles', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/x.PMTILES#v2' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
  })
})
