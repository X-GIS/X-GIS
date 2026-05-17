// Pin URL escaping inside emitted xgis source blocks. Pre-fix the
// converter inlined raw `url: "${url}"` — any URL containing `"`,
// `\`, or control chars produced malformed xgis that crashed the
// parser at lex time. JSON.stringify gives proper double-quote +
// backslash + control-char escapes.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source URL escape', () => {
  it('URL with double-quote is JSON-escaped', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/x.pmtiles?q="weird"' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    // The quote inside the URL should be backslash-escaped.
    expect(code).toContain('"https://example.com/x.pmtiles?q=\\"weird\\""')
  })

  it('URL with backslash is JSON-escaped', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'raster', tiles: ['https://example.com/{z}/x\\y.png'] } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('x\\\\y.png')
  })

  it('plain URL unchanged (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('"https://example.com/x.pmtiles"')
  })
})
