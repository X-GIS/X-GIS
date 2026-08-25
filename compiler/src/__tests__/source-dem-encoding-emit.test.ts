// #2003 (T2 terrain track Phase 1, docs/plans/2026-08-24-terrain-track.md) — a SOURCE-level
// `raster-dem` `encoding` (+ `custom` unpack factors) must reach the runtime instead of being
// warned away with a stale "when hillshade lands" promise.
//
// The gap this closes: hillshade landed in #777 Phase II and the whole decode chain — grammar
// (ir/lower.ts) → interpreter → source-manager → demUnpack() (map/src/render/hillshade-
// renderer.ts) — already threads `encoding`/`redFactor`/`greenFactor`/`blueFactor`/`baseShift`
// end to end (see raster-dem-hillshade-pipeline.test.ts, which pins the hand-authored-`.xgis`
// half of that chain). The converter was the ONE missing hop: without it, a Mapbox style
// declaring `encoding: "terrarium"` silently decoded with the mapbox formula instead — not a
// subtle drift, saturated-garbage elevation (see the design doc's mid-grey-texel worked
// example).
//
// Mirrors #1985's source-scheme-emit.test.ts structure (same shape of gap, one property over).
//
// The DECODED-elevation distinguishing check (CLAUDE.md §12 "the assertion that failed either
// way") lives in a SEPARATE file — map/src/render/hillshade-dem-encoding-decode.test.ts — because
// it must call the real demUnpack(), and demUnpack lives in @xgis/map, which @xgis/compiler must
// not depend on (the reverse dependency: @xgis/map already depends on @xgis/compiler). This file
// pins the emitted TEXT and its threading through lower → emitCommands; that one pins the DECODE.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower, emitCommands } from '..'
import { withPragma } from './_pragma'

/** Parse + lower only — the IR `Scene`, one stage BEFORE emitCommands. Kept separate so a cut
 *  to `lowerSource` and a cut to the `LoadCommand` pass-through red different assertions
 *  instead of the same one (assert the cause before the effect — CLAUDE.md §12). */
const toScene = (src: string) => lower(new Parser(new Lexer(withPragma(src)).tokenize()).parse())

function convert(style: unknown): { code: string; warnings: string[] } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const code = convertMapboxStyle(style as never, { coverage })
  return { code, warnings: coverage.warnings }
}

/** The emitted `source <id> { … }` block, verbatim. */
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

const demStyle = (extra: Record<string, unknown>) => ({
  version: 8,
  sources: { dem: { type: 'raster-dem', tiles: ['https://d/{z}/{x}/{y}.png'], ...extra } },
  layers: [{ id: 'h', type: 'hillshade', source: 'dem' }],
})

const encodingWarnings = (w: string[]) => w.filter((s) => s.includes('encoding'))

describe('#2003 EM1 — the converter EMITS the DEM encoding instead of warning', () => {
  it('encoding: "terrarium" reaches the xgis block, with no warning', () => {
    const { code, warnings } = convert(demStyle({ encoding: 'terrarium' }))
    expect(sourceBlock(code, 'dem')).toContain('encoding: terrarium')
    expect(encodingWarnings(warnings)).toEqual([])
  })

  it('the retired warning is GONE — nothing tells the author to wait for hillshade to land', () => {
    const { warnings } = convert(demStyle({ encoding: 'terrarium' }))
    expect(warnings.some((s) => s.includes('when hillshade lands'))).toBe(false)
    expect(warnings.some((s) => s.includes('Batch-4 hillshade renderer'))).toBe(false)
  })

  it('encoding: "mapbox" emits NOTHING — it is the runtime default', () => {
    const { code, warnings } = convert(demStyle({ encoding: 'mapbox' }))
    expect(sourceBlock(code, 'dem')).not.toContain('encoding')
    expect(encodingWarnings(warnings)).toEqual([])
  })

  it('a mapbox-encoded source is byte-identical to one that declares no encoding at all', () => {
    // The regression guard the design doc names: only a NON-default encoding may move
    // the 9-style snapshot corpus; an explicit "mapbox" must convert exactly like "absent".
    const declared = convert(demStyle({ encoding: 'mapbox' }))
    const omitted = convert(demStyle({}))
    expect(declared.code).toBe(omitted.code)
    expect(declared.warnings).toEqual(omitted.warnings)
  })
})

describe('#2003 EM2 — `custom` emits only the factors the style actually declares', () => {
  it('only redFactor given: emits encoding: custom + redFactor alone', () => {
    const { code } = convert(demStyle({ encoding: 'custom', redFactor: 5000 }))
    const block = sourceBlock(code, 'dem')
    expect(block).toContain('encoding: custom')
    expect(block).toContain('redFactor: 5000')
    // The other three lanes are NOT emitted — demUnpack() falls back to the mapbox
    // factor for any lane the custom pack leaves out (its documented behaviour), so a
    // partial custom pack is a legitimate style, not something to pad with guesses.
    expect(block).not.toContain('greenFactor')
    expect(block).not.toContain('blueFactor')
    expect(block).not.toContain('baseShift')
  })

  it('all four factors given: emits all four', () => {
    const { code } = convert(
      demStyle({ encoding: 'custom', redFactor: 1, greenFactor: 2, blueFactor: 3, baseShift: 4 }),
    )
    const block = sourceBlock(code, 'dem')
    expect(block).toContain('redFactor: 1')
    expect(block).toContain('greenFactor: 2')
    expect(block).toContain('blueFactor: 3')
    expect(block).toContain('baseShift: 4')
  })

  it('no factors given: emits just `encoding: custom` — every lane falls back to mapbox', () => {
    const { code } = convert(demStyle({ encoding: 'custom' }))
    const block = sourceBlock(code, 'dem')
    expect(block).toContain('encoding: custom')
    expect(block).not.toMatch(/(red|green|blue)Factor|baseShift/)
  })

  it('a negative factor is dropped, not emitted — it would round-trip to nothing', () => {
    // lowerSource matches a bare NumberLiteral for each factor; a negative value parses
    // as a UnaryExpr and falls through unmatched (mirrors the emittableZoom guard for
    // source-level maxzoom/minzoom just above this arm in sources.ts).
    const { code } = convert(demStyle({ encoding: 'custom', redFactor: -5000, greenFactor: 7 }))
    const block = sourceBlock(code, 'dem')
    expect(block).not.toContain('redFactor')
    expect(block).toContain('greenFactor: 7')
  })
})

describe('#2003 EM3 — an unrecognised encoding warns and emits nothing', () => {
  for (const bad of ['foo', 'Mapbox', 'TERRARIUM']) {
    it(`encoding: "${bad}" warns naming the value, and emits nothing`, () => {
      const { code, warnings } = convert(demStyle({ encoding: bad }))
      const w = encodingWarnings(warnings)
      expect(w.length).toBe(1)
      expect(w[0]).toContain(bad)
      expect(w[0]).toContain('mapbox')
      expect(sourceBlock(code, 'dem')).not.toContain('encoding:')
    })
  }

  it('a non-string encoding is silently ignored — pre-existing behaviour, unchanged', () => {
    const { code, warnings } = convert(demStyle({ encoding: 3 }))
    expect(encodingWarnings(warnings)).toEqual([])
    expect(sourceBlock(code, 'dem')).not.toContain('encoding:')
  })
})

describe('#2003 EM4 — the grammar round-trips through the full pipeline', () => {
  it('CAUSE: lowerSource lands `encoding: custom` + a factor on the IR SourceDef', () => {
    const scene = toScene(
      'source s { type: "raster-dem", url: "https://d/{z}/{x}/{y}.png", encoding: custom, redFactor: 5000 }\n' +
        'layer l { source: s }',
    )
    const s = scene.sources.find((x) => x.name === 's')
    expect(s?.encoding).toBe('custom')
    expect(s?.redFactor).toBe(5000)
  })

  it('EFFECT: emitCommands carries the SourceDef encoding + factor onto the LoadCommand', () => {
    // Same input as the CAUSE above; only the extra stage differs, so a cut to the
    // pass-through reds this one alone and a cut to lowerSource reds both.
    const cmds = emitCommands(
      toScene(
        'source s { type: "raster-dem", url: "https://d/{z}/{x}/{y}.png", encoding: custom, redFactor: 5000 }\n' +
          'layer l { source: s }',
      ),
    )
    const load = cmds.loads.find((l) => l.name === 's')
    expect(load?.encoding).toBe('custom')
    expect(load?.redFactor).toBe(5000)
  })

  it('the CONVERTER output re-parses and lands encoding + factors on the LoadCommand', () => {
    const { code } = convert(demStyle({ encoding: 'custom', redFactor: 5000, blueFactor: 0.05 }))
    const load = compile(code).loads.find((l) => l.name === 'dem')
    expect(load?.encoding).toBe('custom')
    expect(load?.redFactor).toBe(5000)
    expect(load?.blueFactor).toBe(0.05)
    expect(load?.greenFactor).toBeUndefined()
  })

  it('the CONVERTER output re-parses terrarium onto the LoadCommand', () => {
    const { code } = convert(demStyle({ encoding: 'terrarium' }))
    const load = compile(code).loads.find((l) => l.name === 'dem')
    expect(load?.encoding).toBe('terrarium')
  })
})
