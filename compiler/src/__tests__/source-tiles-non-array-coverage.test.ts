// Pin defensive guard against src.tiles authored as a bare string
// (common cut-and-paste mistake from `url:` syntax). Pre-fix
// `src.tiles?.[0]` returned the first CHAR of the string (e.g.
// 'h' for 'https://...'), producing a broken xgis source URL.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source.tiles non-array guard', () => {
  it('bare string tiles falls back to src.url, no char-indexing', () => {
    const style = {
      version: 8,
      sources: {
        s: {
          type: 'raster',
          tiles: 'https://example.com/{z}/{x}/{y}.png' as unknown,
          url: 'https://fallback.example.com/tiles.json',
        },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    // Should NOT contain a URL starting with single char 'h' (length 1).
    expect(code).not.toMatch(/url: "h"/)
    // Falls back to the `url:` value.
    expect(code).toContain('https://fallback.example.com/tiles.json')
  })

  it('bare string tiles with no url emits placeholder', () => {
    const style = {
      version: 8,
      sources: {
        s: {
          type: 'raster',
          tiles: 'https://example.com/{z}/{x}/{y}.png' as unknown,
        },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/url: "h"/)
    expect(code).toMatch(/TODO: raster source missing url\/tiles/)
  })

  it('regression: array tiles still emits first URL', () => {
    const style = {
      version: 8,
      sources: {
        s: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('url: "https://example.com/{z}/{x}/{y}.png"')
  })
})
