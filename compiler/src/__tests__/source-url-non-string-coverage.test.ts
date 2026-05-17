// Pin defensive guard against src.url authored as a non-string
// (object / array / number). Pre-fix the value flowed through
// JSON.stringify and emitted into the xgis as a literal url string
// like 'url: "{\"foo\":1}"' which the runtime then tried to fetch
// verbatim.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source.url non-string guard', () => {
  it('object url falls back to tiles[0]', () => {
    const style = {
      version: 8,
      sources: {
        s: {
          type: 'vector',
          url: { weird: 'object' } as unknown,
          tiles: ['https://fallback.example.com/{z}/{x}/{y}.pbf'],
        },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('"weird"')
    expect(code).toContain('https://fallback.example.com/{z}/{x}/{y}.pbf')
  })

  it('number url + no tiles emits placeholder', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'raster', url: 42 as unknown } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('url: "42"')
    expect(code).toMatch(/TODO: raster source missing url\/tiles/)
  })

  it('regression: valid string url unchanged', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('url: "https://x.pmtiles"')
  })
})
