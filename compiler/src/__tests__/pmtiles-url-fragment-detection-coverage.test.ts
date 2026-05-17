// Pin PMTiles URL detection for fragment-bearing URLs. Pre-fix the
// regex `/\.pmtiles(\?|$)/` rejected `https://example.com/x.pmtiles#frag`
// — the underlying file IS a pmtiles archive but the fragment after
// the extension made the converter route through TileJSON, the
// runtime then failed the manifest fetch on a non-JSON URL, and the
// source silently dropped.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('PMTiles URL detection with fragment / query', () => {
  it('URL with #fragment routes to pmtiles', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'vector', url: 'https://example.com/x.pmtiles#frag' },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
    expect(code).not.toContain('type: tilejson')
  })

  it('URL with ?query routes to pmtiles (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/x.pmtiles?v=2' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
  })

  it('bare .pmtiles URL still routes (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: pmtiles')
  })

  it('non-pmtiles URL routes to tilejson', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/tiles.json' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('type: tilejson')
    expect(code).not.toContain('type: pmtiles')
  })
})
