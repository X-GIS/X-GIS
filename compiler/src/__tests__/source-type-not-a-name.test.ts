// A source `type:` that is neither a bare identifier nor a quoted string
// used to leave `lowerSource`'s `geojson` default standing with NO
// diagnostic (#2549) — the silence is what made an editor round-trip's
// data loss invisible. A hyphenated name written bare tokenises as a
// subtraction expression, so it lands on exactly that path.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { SOURCE_TYPE_NOT_A_NAME } from '../diagnostics/diagnostic'
import { withPragma } from './_pragma'

function compile(source: string) {
  return lower(new Parser(new Lexer(withPragma(source)).tokenize()).parse())
}

describe('source type that is not a name (#2549)', () => {
  it('a bare hyphenated type is a diagnostic naming the source, not a silent geojson', () => {
    const scene = compile(`
      source admin {
        type: x-kr-admin
        url: "https://example.com/admin"
      }
    `)
    const diag = (scene.diagnostics ?? []).find((d) => d.code === SOURCE_TYPE_NOT_A_NAME)
    expect(diag, 'expected a X-GIS0030 diagnostic').toBeTruthy()
    expect(diag!.message).toContain('Source "admin"')
    expect(diag!.severity).toBe('error')
  })

  it("the Mapbox converter's own raster-dem output lowers as raster-dem, silently", () => {
    // A REAL caller's bytes, not a hand-built ideal: `raster-dem` is the one
    // built-in whose name is not identifier-shaped, and the converter emitted it
    // bare — so every converted terrain style lowered as a geojson source.
    const style = {
      version: 8,
      sources: {
        terrain: { type: 'raster-dem', tiles: ['https://dem/{z}/{x}/{y}.png'], tileSize: 512 },
      },
      layers: [{ id: 'h', type: 'hillshade', source: 'terrain' }],
    }
    const scene = lower(
      new Parser(new Lexer(convertMapboxStyle(style as never)).tokenize()).parse(),
    )
    expect(scene.sources[0].type).toBe('raster-dem')
    expect((scene.diagnostics ?? []).filter((d) => d.code === SOURCE_TYPE_NOT_A_NAME)).toEqual([])
  })

  it('the two well-formed spellings stay silent', () => {
    const scene = compile(`
      source builtin { type: geojson url: "a.geojson" }
      source custom { type: "x-kr-admin" url: "https://example.com/admin" }
    `)
    expect((scene.diagnostics ?? []).filter((d) => d.code === SOURCE_TYPE_NOT_A_NAME)).toEqual([])
    expect(scene.sources.map((s) => s.type)).toEqual(['geojson', 'x-kr-admin'])
  })
})
