// Pin warning when a source has `minzoom > maxzoom`. Mirror of the
// per-layer zoom-inversion check. Pre-fix the empty servable-zoom
// range silently filtered every tile request → 404, and dependent
// layers stayed blank with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source minzoom > maxzoom inversion', () => {
  it('warns on inverted source zoom range', () => {
    const style = {
      version: 8,
      sources: {
        broken: {
          type: 'vector',
          url: 'https://example.com/v.pmtiles',
          minzoom: 14,
          maxzoom: 4,
        },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Source "broken" has minzoom=14 > maxzoom=4/)
  })

  it('normal source range does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: {
        ok: {
          type: 'vector',
          url: 'https://example.com/v.pmtiles',
          minzoom: 0,
          maxzoom: 14,
        },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/minzoom=.* > maxzoom/)
  })
})
