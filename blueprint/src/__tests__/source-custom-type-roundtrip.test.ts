// A blueprint round trip must not change what a `source` block MEANS (#2549).
//
// The grammar makes quoting load-bearing: a built-in type is a bare identifier
// (`type: geojson`), a CUSTOM registry type is a quoted string
// (`type: "x-kr-admin"`) because a hyphenated key would otherwise tokenise as
// the expression `x - kr - admin`. Emitting it bare made `lowerSource` keep its
// `geojson` default, and every non-reserved property the importer never
// captured (`SourceDef.options`) went with it.
//
// The instrument distinguishes: the `geojson` control round-trips unchanged in
// the same run, so a test that "passes either way" cannot hide here.

import { describe, expect, it, vi } from 'vitest'
import { Lexer, Parser, lower, type SourceDef } from '@xgis/compiler'
import { xgisToGraph } from '../import'
import { graphToXgis } from '../codegen'

function sourceOf(src: string): SourceDef {
  return lower(new Parser(new Lexer(src).tokenize()).parse()).sources[0]
}

/** graph → text, with the importer's "skipped source" console.warn muted. */
function roundTrip(src: string): string {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const out = graphToXgis(xgisToGraph(src))
  warn.mockRestore()
  return out
}

const CUSTOM = `xgis 1

source s {
  type: "x-kr-admin"
  url: "https://x/a"
  region: "kr"
}

layer l { source: s | fill-red-500 }
`

const BUILTIN = `xgis 1

source s {
  type: geojson
  url: "https://x/a"
}

layer l { source: s | fill-red-500 }
`

describe('blueprint round-trip: custom registry source type (#2549)', () => {
  it('keeps the custom type quoted so it does not lower back to geojson', () => {
    expect(roundTrip(CUSTOM)).toContain('type: "x-kr-admin"')
  })

  it('preserves type AND options across xgisToGraph → graphToXgis → lower', () => {
    const before = sourceOf(CUSTOM)
    const after = sourceOf(roundTrip(CUSTOM))
    expect(before.type).toBe('x-kr-admin')
    expect(after.type).toBe(before.type)
    expect(before.options).toEqual({ region: 'kr' })
    expect(after.options).toEqual(before.options)
  })

  it('control: a built-in type still round-trips as a bare identifier', () => {
    expect(roundTrip(BUILTIN)).toContain('type: geojson')
    expect(sourceOf(roundTrip(BUILTIN)).type).toBe(sourceOf(BUILTIN).type)
  })
})
