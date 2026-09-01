// #1985 (ADR-0012 Phase B4) — a SOURCE-level `scheme: "tms"` must reach the runtime
// instead of being warned away.
//
// The gap this closes, one property over from #1983 (tileSize/maxzoom/minzoom) and
// #1984 (bounds):
//
//   • the converter DETECTED `scheme: "tms"` and dropped it with a warning that told
//     the author to "wait for native scheme support";
//   • `lowerSource` claimed no `scheme` key, so a hand-authored `scheme: tms` fell into
//     the custom-loader options bag (bare identifier: silently discarded, since that
//     branch collects only String/Number/Array literals; quoted `"tms"`: collected as
//     a custom option nothing reads);
//   • and the request path had no row-origin concept at all, so a TMS endpoint rendered
//     the whole map mirrored on Y.
//
// GRAMMAR: `scheme: tms` needs ZERO new productions. `parseBlockProperty` parses a full
// expression, so the bare form arrives as `Identifier` and the quoted form as
// `StringLiteral` — the SAME pair `type:` and `encoding:` already accept. Both are
// pinned below against the real Lexer + Parser.
//
// PER-TYPE EMIT: `raster` / `raster-dem` emit, because those are the two arms whose
// requests go through `tileUrl` (data/src/tile-select-helpers.ts). The vector family
// does not: `data/src/vector-tile-loader.ts` builds its URLs in a SECOND {z}/{x}/{y}
// substitution that never sees a SourceDef, and a PMTiles archive is XYZ by
// specification. Emitting a line nothing reads is the silent gap wearing a different
// hat, so those types keep a NARROWED warning that says which path is responsible.
//
// `xyz` is the default and is deliberately not emitted — an explicit `scheme: xyz` line
// would mean exactly what its absence means, and would churn every raster source in the
// converted corpus for no behavioural change.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower, emitCommands } from '..'
import { withPragma } from './_pragma'

/** Parse + lower only — the IR `Scene`, one stage BEFORE emitCommands. Kept separate
 *  so a cut to `lowerSource` and a cut to the `LoadCommand` pass-through red different
 *  assertions instead of the same five (assert the cause before the effect). */
const toScene = (src: string) => lower(new Parser(new Lexer(withPragma(src)).tokenize()).parse())

function convert(style: unknown): { code: string; warnings: string[] } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const code = convertMapboxStyle(style as never, { coverage })
  return { code, warnings: coverage.warnings }
}

/** The emitted `source <id> { … }` block, verbatim. Line-scanned rather than
 *  regex-matched: tile URL templates carry literal `{z}/{x}/{y}` braces. */
function sourceBlock(code: string, id: string): string {
  const lines = code.split('\n')
  const start = lines.indexOf(`source ${id} {`)
  expect(start, `no source block for "${id}" in:\n${code}`).toBeGreaterThanOrEqual(0)
  const end = lines.indexOf('}', start)
  return lines.slice(start, end + 1).join('\n')
}

/** Lower + emit a `.xgis` program to its runtime commands. */
const compile = (src: string) =>
  emitCommands(lower(new Parser(new Lexer(withPragma(src)).tokenize()).parse()))

const rasterStyle = (extra: Record<string, unknown>) => ({
  version: 8,
  sources: { legacy: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'], ...extra } },
  layers: [{ id: 'r', type: 'raster', source: 'legacy' }],
})

const schemeWarnings = (w: string[]) => w.filter((s) => s.includes('scheme'))

describe('#1985 W1 — the converter EMITS the row origin instead of warning', () => {
  it('a raster source: `scheme: tms` reaches the xgis block, with no warning', () => {
    const { code, warnings } = convert(rasterStyle({ scheme: 'tms' }))
    expect(sourceBlock(code, 'legacy')).toContain('scheme: tms')
    expect(schemeWarnings(warnings)).toEqual([])
  })

  it('the retired warning is GONE — nothing tells the author to wait for support', () => {
    const { warnings } = convert(rasterStyle({ scheme: 'tms' }))
    expect(warnings.some((s) => s.includes('Y-flipped'))).toBe(false)
    expect(warnings.some((s) => s.includes('native scheme support'))).toBe(false)
  })

  it('a raster-dem source emits it too — the hillshade twin shares the request path', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: {
        dem: {
          type: 'raster-dem',
          tiles: ['https://d/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          scheme: 'tms',
        },
      },
      layers: [{ id: 'h', type: 'hillshade', source: 'dem' }],
    })
    expect(sourceBlock(code, 'dem')).toContain('scheme: tms')
    expect(schemeWarnings(warnings)).toEqual([])
  })

  it('`scheme: "xyz"` emits NOTHING and warns about nothing — it is the default', () => {
    const { code, warnings } = convert(rasterStyle({ scheme: 'xyz' }))
    expect(sourceBlock(code, 'legacy')).not.toContain('scheme')
    expect(schemeWarnings(warnings)).toEqual([])
  })

  it('an xyz raster source is byte-identical to one that declares no scheme at all', () => {
    // The regression guard the issue names: an existing style must convert unchanged.
    const declared = convert(rasterStyle({ scheme: 'xyz' }))
    const omitted = convert(rasterStyle({}))
    expect(declared.code).toBe(omitted.code)
    expect(declared.warnings).toEqual(omitted.warnings)
  })
})

describe('#1985 W2 — an unknown scheme falls back to xyz and says so', () => {
  for (const bad of ['wms', 'XYZ', 'TMS']) {
    it(`\`scheme: "${bad}"\` warns naming the value, and emits nothing`, () => {
      const { code, warnings } = convert(rasterStyle({ scheme: bad }))
      const w = schemeWarnings(warnings)
      expect(w.length).toBe(1)
      expect(w[0]).toContain(bad)
      expect(w[0]).toContain('xyz')
      expect(sourceBlock(code, 'legacy')).not.toContain('scheme:')
    })
  }

  it('a non-string scheme warns rather than emitting a nonsense line', () => {
    const { code, warnings } = convert(rasterStyle({ scheme: 3 }))
    expect(schemeWarnings(warnings).length).toBe(1)
    expect(sourceBlock(code, 'legacy')).not.toContain('scheme:')
  })
})

describe('#1985 W3 — types with no request-path consumer keep a NARROWED warning', () => {
  it('a vector source: warns naming vector-tile-loader, and emits no scheme line', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://v/{z}/{x}/{y}.mvt'], scheme: 'tms' } },
      layers: [{ id: 'l', type: 'line', source: 'v', 'source-layer': 'roads' }],
    })
    const w = schemeWarnings(warnings)
    expect(w.length).toBe(1)
    expect(w[0]).toContain('vector-tile-loader')
    expect(w[0]).toContain('raster / raster-dem')
    expect(sourceBlock(code, 'v')).not.toContain('scheme:')
  })

  it('a geojson source declaring tms warns too (no tile request path at all)', () => {
    const { warnings } = convert({
      version: 8,
      sources: { g: { type: 'geojson', data: 'https://g/x.geojson', scheme: 'tms' } },
      layers: [{ id: 'l', type: 'fill', source: 'g' }],
    })
    expect(schemeWarnings(warnings).length).toBe(1)
  })

  it('a vector source declaring xyz is silent — the default needs no diagnostic', () => {
    const { warnings } = convert({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://v/{z}/{x}/{y}.mvt'], scheme: 'xyz' } },
      layers: [{ id: 'l', type: 'line', source: 'v', 'source-layer': 'roads' }],
    })
    expect(schemeWarnings(warnings)).toEqual([])
  })
})

describe('#1985 W4 — the grammar round-trips, with zero new productions', () => {
  it('CAUSE: lowerSource lands the scheme on the IR SourceDef', () => {
    const scene = toScene(
      'source s { type: raster, url: "https://x/{z}/{x}/{y}.png", scheme: tms }\n' +
        'layer l { source: s }',
    )
    expect(scene.sources.find((s) => s.name === 's')?.scheme).toBe('tms')
  })

  it('EFFECT: emitCommands carries the SourceDef scheme onto the LoadCommand', () => {
    // Same input as the CAUSE above; only the extra stage differs, so a cut to the
    // pass-through reds this one alone and a cut to lowerSource reds both.
    const cmds = emitCommands(
      toScene(
        'source s { type: raster, url: "https://x/{z}/{x}/{y}.png", scheme: tms }\n' +
          'layer l { source: s }',
      ),
    )
    expect(cmds.loads.find((l) => l.name === 's')?.scheme).toBe('tms')
  })

  it('the CONVERTER output re-parses and lands scheme on the LoadCommand', () => {
    const { code } = convert(rasterStyle({ scheme: 'tms' }))
    const load = compile(code).loads.find((l) => l.name === 'legacy')
    expect(load?.scheme).toBe('tms')
  })

  it('a hand-authored bare identifier lowers (`scheme: tms`)', () => {
    const cmds = compile(
      'source s { type: raster, url: "https://x/{z}/{x}/{y}.png", scheme: tms }\n' +
        'layer l { source: s }',
    )
    expect(cmds.loads.find((l) => l.name === 's')?.scheme).toBe('tms')
  })

  it('a hand-authored quoted string lowers too (`scheme: "tms"`)', () => {
    const cmds = compile(
      'source s { type: raster, url: "https://x/{z}/{x}/{y}.png", scheme: "tms" }\n' +
        'layer l { source: s }',
    )
    expect(cmds.loads.find((l) => l.name === 's')?.scheme).toBe('tms')
  })

  it('`scheme: xyz` lowers to the literal value, not undefined', () => {
    const cmds = compile(
      'source s { type: raster, url: "https://x/{z}/{x}/{y}.png", scheme: xyz }\n' +
        'layer l { source: s }',
    )
    expect(cmds.loads.find((l) => l.name === 's')?.scheme).toBe('xyz')
  })

  it('an unknown value lowers to undefined — the xyz default, never a bogus scheme', () => {
    for (const form of ['scheme: TMS', 'scheme: "wms"', 'scheme: 3']) {
      const cmds = compile(
        `source s { type: raster, url: "https://x/{z}/{x}/{y}.png", ${form} }\nlayer l { source: s }`,
      )
      expect(cmds.loads.find((l) => l.name === 's')?.scheme, form).toBeUndefined()
    }
  })

  it('a source that declares no scheme leaves it undefined — xyz, as before', () => {
    const cmds = compile(
      'source s { type: raster, url: "https://x/{z}/{x}/{y}.png" }\nlayer l { source: s }',
    )
    expect(cmds.loads.find((l) => l.name === 's')?.scheme).toBeUndefined()
  })
})

describe('#1985 W4b — a `{-y}` template is a COMPLETE raster template', () => {
  // `{-y}` is now substituted by `tileUrl`, so the placeholder-completeness check must
  // stop reporting a working TMS template as "missing {y}". Only the two arms whose
  // requests go through that builder relax; the vector arm keeps the strict test,
  // because vector-tile-loader.ts has no `{-y}` branch and such a URL really is broken
  // there. `isTileTemplate` (data/) is deliberately NOT relaxed for the same reason —
  // it also gates the vector-family sniffing in source-manager.
  const withTiles = (type: string, tile: string) => ({
    version: 8,
    sources: { s: { type, tiles: [tile] } },
    layers: [{ id: 'l', type: type === 'raster-dem' ? 'hillshade' : 'raster', source: 's' }],
  })
  const missingWarnings = (w: string[]) => w.filter((s) => s.includes('missing required URL'))

  it('a raster `{z}/{x}/{-y}` template does NOT warn about a missing {y}', () => {
    expect(missingWarnings(convert(withTiles('raster', 'https://x/{z}/{x}/{-y}.png')).warnings)) //
      .toEqual([])
  })

  it('a raster-dem `{z}/{x}/{-y}` template does NOT warn either', () => {
    expect(
      missingWarnings(convert(withTiles('raster-dem', 'https://d/{z}/{x}/{-y}.png')).warnings),
    ).toEqual([])
  })

  it('a raster template genuinely missing the row STILL warns (the decoy)', () => {
    const w = missingWarnings(convert(withTiles('raster', 'https://x/{z}/{x}/tile.png')).warnings)
    expect(w.length).toBe(1)
    expect(w[0]).toContain('{y}')
  })

  it('a VECTOR `{-y}` template still warns — that path cannot substitute it', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', tiles: ['https://v/{z}/{x}/{-y}.mvt'] } },
      layers: [{ id: 'l', type: 'line', source: 's', 'source-layer': 'roads' }],
    }
    const w = missingWarnings(convert(style).warnings)
    expect(w.length).toBe(1)
    expect(w[0]).toContain('{y}')
  })
})

describe('#1985 W5 — `scheme` is now a RESERVED key, so it cannot leak to `options`', () => {
  // Mirror of #1304's `refresh` rule (source-refresh-pipeline.test.ts): a key claimed by
  // `lowerSource` must NOT also reach the custom-loader options bag, or a registry
  // loader would see a second, uncoordinated copy of the same declaration. Before this
  // issue the QUOTED form did exactly that.
  it('a quoted `scheme: "tms"` no longer appears in the custom-loader options bag', () => {
    const cmds = compile(
      'source s { type: "x-custom", url: "https://x/{z}/{x}/{y}.png", scheme: "tms" }\n' +
        'layer l { source: s }',
    )
    const load = cmds.loads.find((l) => l.name === 's')
    expect(load?.options?.scheme).toBeUndefined()
    expect(load?.scheme).toBe('tms')
  })

  it('a genuinely custom sibling key still reaches options (the decoy)', () => {
    const cmds = compile(
      'source s { type: "x-custom", url: "https://x/y", scheme: "tms", region: "kr" }\n' +
        'layer l { source: s }',
    )
    expect(cmds.loads.find((l) => l.name === 's')?.options).toEqual({ region: 'kr' })
  })
})
