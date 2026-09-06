// Blueprint round-trip fidelity for a source's `type:` and its custom
// options bag (#2549).
//
// The grammar makes the quoting of `type:` load-bearing: a name that is
// not a bare identifier ([a-zA-Z_][a-zA-Z0-9_]*) — every custom registry
// type (`"x-kr-admin"`) and the hyphenated built-in `"raster-dem"` — MUST
// be a quoted string, or it tokenises as a subtraction expression and
// `lowerSource` silently keeps its `geojson` default (compiler/src/ir/
// lower.ts:147-152). The witness is the editor round trip: lowering the
// re-emitted text must agree with lowering the original.

import { describe, it, expect, vi } from 'vitest'
import { Lexer, Parser, lower } from '@xgis/compiler'
import { xgisToGraph } from '../import'
import { graphToXgis } from '../codegen'

function lowerXgis(src: string) {
  return lower(new Parser(new Lexer(src).tokenize()).parse())
}

/** Load into the editor and save again — the exact path the blueprint UI takes. */
function roundTrip(src: string): string {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const out = graphToXgis(xgisToGraph(src))
  warn.mockRestore()
  return out
}

/** A real `.xgis` document as the editor receives it: version pragma, a
 *  source block, a layer wired to it. */
function scene(sourceBlock: string): string {
  return `xgis 1

${sourceBlock}

layer districts {
  source: s
  | fill-red-500
}
`
}

describe('blueprint round-trip: source type + options (#2549)', () => {
  it('a custom registry type keeps its type AND its options', () => {
    const src = scene(`source s {
  type: "x-kr-admin"
  url: "https://example.com/admin"
  region: "kr"
}`)
    const before = lowerXgis(src).sources[0]
    expect(before.type).toBe('x-kr-admin')
    expect(before.options).toEqual({ region: 'kr' })

    const out = roundTrip(src)
    expect(out).toContain('type: "x-kr-admin"')

    const after = lowerXgis(out).sources[0]
    expect(after.type).toBe(before.type)
    expect(after.options).toEqual(before.options)
  })

  it('the hyphenated built-in `raster-dem` survives too', () => {
    const src = scene(`source s {
  type: "raster-dem"
  url: "https://example.com/{z}/{x}/{y}.png"
}`)
    expect(lowerXgis(src).sources[0].type).toBe('raster-dem')

    const out = roundTrip(src)
    expect(out).toContain('type: "raster-dem"')
    expect(lowerXgis(out).sources[0].type).toBe('raster-dem')
  })

  it('control: a bare built-in type round-trips unchanged', () => {
    const src = scene(`source s {
  type: geojson
  url: "land.geojson"
}`)
    const before = lowerXgis(src).sources[0]

    const out = roundTrip(src)
    // An identifier-shaped type stays bare — the idiomatic spelling.
    expect(out).toContain('type: geojson')

    const after = lowerXgis(out).sources[0]
    expect(after.type).toBe(before.type)
    expect(after.options).toEqual(before.options)
  })
})
