// Pin defensive coercion of malformed style.sources.
// Pre-fix Object.entries on a string yielded char-index entries
// (0:"h", 1:"t", …) and convertSource was called with garbage; on
// an array it iterated by index. Both produced corrupt output.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('style.sources non-object coercion', () => {
  it('string sources value treated as empty object', () => {
    const style = { version: 8, sources: 'oops' as unknown, layers: [] }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    // No `source 0 {` / `source 1 {` from char-iteration.
    expect(code).not.toMatch(/source [0-9]+ \{/)
  })

  it('array sources value treated as empty object', () => {
    const style = { version: 8, sources: [] as unknown, layers: [] }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/source 0 \{/)
  })

  it('null sources value treated as empty object', () => {
    const style = { version: 8, sources: null as unknown, layers: [] }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('regression: valid sources object iterates normally', () => {
    const style = {
      version: 8,
      sources: { a: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('source a {')
  })
})
