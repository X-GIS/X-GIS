// Pin Protomaps `pmtiles://` URL prefix stripping. Pre-fix the
// emitted source carried the full 'pmtiles://https://...' URL and
// the runtime fetch failed verbatim ("Failed to fetch" / CORS
// preflight on the made-up `pmtiles:` scheme).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('pmtiles:// scheme prefix', () => {
  it('strips pmtiles:// prefix from src.url', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'pmtiles://https://example.com/x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
    expect(code).toContain('url: "https://example.com/x.pmtiles"')
    expect(code).not.toContain('pmtiles://')
  })

  it('strips pmtiles:// prefix from src.tiles[0]', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', tiles: ['pmtiles://https://example.com/x.pmtiles'] } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('url: "https://example.com/x.pmtiles"')
    expect(code).not.toContain('pmtiles://')
  })

  it('regression: bare https URL unchanged', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('url: "https://example.com/x.pmtiles"')
  })
})
