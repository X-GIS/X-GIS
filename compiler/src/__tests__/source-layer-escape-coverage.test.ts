// Pin sourceLayer + style.name escape. sourceLayer was inlined raw
// in a quoted string; an MVT layer name containing `"` or `\` broke
// the parser. style.name was inlined inside a /* */ comment; a name
// containing `*/` prematurely closed the comment block.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source-layer + style.name escape', () => {
  it('source-layer with embedded quote is JSON-escaped', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          'source-layer': 'name"with"quote',
          paint: { 'fill-color': '#000' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('sourceLayer: "name\\"with\\"quote"')
  })

  it('style.name with */ is sanitized (no premature comment close)', () => {
    const style = {
      version: 8,
      name: 'foo */ bar',
      sources: {},
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    // The first line is a comment carrying the name. The `*/` inside
    // must NOT close the comment block before its intended end.
    const firstLine = code.split('\n')[0]
    expect(firstLine).toMatch(/^\/\*.*\*\/$/)
    // Validate the comment terminator is at the END only — exactly
    // one `*/` per line.
    expect((firstLine.match(/\*\//g) ?? []).length).toBe(1)
  })

  it('plain source-layer name unchanged (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          'source-layer': 'water',
          paint: { 'fill-color': '#000' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('sourceLayer: "water"')
  })
})
