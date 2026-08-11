// ═══ #1664 — the arrow paint's colour CATCH is wired to the warning (integration) ═══
//
// `per-feature-color-warning.test.ts` pins what the message SAYS; the compiler's
// `point-fill-color-expr.test.ts` pins which expressions the evaluator can bake. Neither
// touches the WIRE between them, and that wire is the whole fix: the catch in
// `addArrowShowLayer` used to swallow an unresolvable colour, and the layer painted flat
// white with nothing logged for the life of #1592.
//
// So this drives the exported `addArrowShowLayer` end to end — a real compiled
// ShowCommand, a real FeatureCollection, the real evaluator — and reads BOTH halves of
// the contract at once: the warning reaches the log sink, AND the arrow that could not be
// coloured falls back to the layer default rather than to opaque black.
//
// The graphics manager is stubbed to the ONE method this path calls
// (`addCompiledArrowLayer`), the `coverage-arm-arrows.test.ts` idiom — the arrow batch is
// captured as data, so no GPU is involved.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { setLogSink } from '@xgis/shared'
import { Lexer, Parser, lower, emitCommands } from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '@xgis/data'
import { addArrowShowLayer, type ArrowShowHost } from './arrow-show'
import { resetPerFeatureColorWarnings } from './render/per-feature-color-warning'
import type { ShowCommand } from './render/renderer-types'

/** coops-currents' arrow layer shape, with the `fill` clause under test. */
function arrowShow(fill: string): ShowCommand {
  const src = `xgis 1
source stations { type: geojson }
layer arrows {
  source: stations
  | arrow bearing-[.dir] size-[44]
  | ${fill}
}
`
  const cmds = emitCommands(lower(new Parser(new Lexer(src).tokenize()).parse()))
  const show = cmds.shows.find((s) => s.layerName === 'arrows')
  if (!show) throw new Error('no `arrows` show')
  return show as unknown as ShowCommand
}

/** Two stations, both carrying the properties the fill clauses read. */
const FC: GeoJSONFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.4, 37.8] },
      properties: { dir: 90, band: 'a', speed: 30, colorName: 'red' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.3, 37.7] },
      properties: { dir: 180, band: 'b', speed: 90, colorName: 'sky-300' },
    },
  ],
} as unknown as GeoJSONFeatureCollection

interface Batch {
  colors: Array<[number, number, number, number]>
}

function makeHost(): { host: ArrowShowHost; batches: Batch[] } {
  const batches: Batch[] = []
  const host = {
    graphics: {
      addCompiledArrowLayer: (
        _lons: Float64Array,
        _lats: Float64Array,
        _bearings: Float32Array,
        _sizes: Float32Array,
        colors: Array<[number, number, number, number]>,
      ) => void batches.push({ colors }),
    },
    camera: { zoom: 6, pitch: 0 },
  } as unknown as ArrowShowHost
  return { host, batches }
}

let warnings: string[] = []

beforeEach(() => {
  resetPerFeatureColorWarnings()
  warnings = []
  setLogSink((level, message) => {
    if (level === 'warn') warnings.push(message)
  })
})
afterEach(() => setLogSink(null))

describe('addArrowShowLayer — an unresolvable per-feature fill REPORTS itself (#1664)', () => {
  it('a categorical() fill the CPU cannot bake warns, and the arrow is NOT black', () => {
    // `categorical()` exists only in the shader (auto-palette indexing) and stays
    // deliberately outside `callBuiltin`, so `evaluate` throws — the exact shape of
    // "this layer's colour never resolved". The throw must surface, once, naming the
    // layer and the axis; and the arrow must keep the flat-white layer default, because
    // a black arrow reads as an authored colour and hides the gap.
    const { host, batches } = makeHost()
    addArrowShowLayer(host, arrowShow('fill categorical(.band)'), FC)

    expect(warnings, 'exactly one report for the layer/axis pair').toHaveLength(1)
    expect(warnings[0]).toContain('arrows')
    expect(warnings[0]).toContain('fill')
    expect(warnings[0]).toContain('#1664')
    expect(warnings[0]).toContain("unknown function 'categorical'")

    expect(batches).toHaveLength(1)
    expect(batches[0]!.colors).toHaveLength(2)
    for (const c of batches[0]!.colors) {
      expect(c, 'the layer default, not opaque black').toEqual([1, 1, 1, 1])
    }
  })

  it('a fill that DOES bake reaches the batch as its colour, and says nothing', () => {
    // The control arm: the same wire, with an expression #1664 taught the evaluator.
    // Without it this test could pass while the warning fired unconditionally.
    const { host, batches } = makeHost()
    addArrowShowLayer(host, arrowShow('fill gradient(.speed, 0, 120, sky-300, rose-600)'), FC)

    expect(warnings, 'a resolvable ramp is silent').toEqual([])
    const colors = batches[0]!.colors
    // #96a6cf at speed 30, #c84a75 at speed 90 — the gradient pin's own hexes.
    expect(colors[0]![0]).toBeCloseTo(0x96 / 255, 5)
    expect(colors[1]![0]).toBeCloseTo(0xc8 / 255, 5)
  })

  it('a string that names no colour warns instead of painting opaque black', () => {
    // The other half of the accept site: the parser used to be TOTAL, so before #1664 any
    // non-hex string — an authored `red`, a data-carried token, a typo — came back as
    // [0,0,0,1] and painted a WRONG colour reported as a right one. The resolver runs
    // first now, and what it cannot resolve falls to the warning. (#1666 removed the total
    // variant outright, so this route cannot be re-armed by picking the wrong helper.)
    const { host, batches } = makeHost()
    addArrowShowLayer(host, arrowShow('fill match(.band) { _ -> "not-a-colour" }'), FC)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('evaluated to "not-a-colour"')
    for (const c of batches[0]!.colors) {
      expect(c, 'never [0,0,0,1]').toEqual([1, 1, 1, 1])
    }
  })

  it('a DATA-CARRIED colour name resolves the way a label colour does', () => {
    // The name has to arrive at RUNTIME to test the runtime resolver: an authored
    // literal is already rewritten to hex at lower time (resolveColorTokenLiterals), so
    // it would pass with or without this fix. A name read out of a feature property
    // cannot be — and pre-#1664 the total parser answered opaque BLACK for `"red"`,
    // while the same string in a label's text-color rendered red (label-pass.ts runs
    // `resolveColor` first). One resolver, both paths, now.
    const { host, batches } = makeHost()
    addArrowShowLayer(host, arrowShow('fill match(.band) { _ -> .colorName }'), FC)

    expect(warnings).toEqual([])
    expect(batches[0]!.colors[0], '"red" → CSS name').toEqual([1, 0, 0, 1])
    const sky = batches[0]!.colors[1]!
    expect(sky[0], '"sky-300" → palette token').toBeCloseTo(0x7d / 255, 5)
    expect(sky[1]).toBeCloseTo(0xd3 / 255, 5)
    expect(sky[2]).toBeCloseTo(0xfc / 255, 5)
  })

  it('a MALFORMED layer-CONSTANT fill falls back to the default, never opaque black (#1666)', () => {
    // The three cases above all fail inside the per-feature EXPRESSION, which #1664 already
    // routed through the nullable parse. The layer CONSTANT — `show.fill`, the value every
    // arrow uses when there is no expression, and the fallback the expression cases return
    // to — was still read by the total parser, so a ShowCommand carrying a non-hex `fill`
    // painted the whole batch [0, 0, 0, 1]. That is a colour the author never wrote,
    // reported as one they did, on the SAME bake path #1664 exists to de-silence.
    //
    // The literal is overwritten rather than authored because the compiler resolves colour
    // tokens at lower time (resolveColorTokenLiterals) and the Mapbox converter now warns
    // and skips a bad hex — a malformed `show.fill` only reaches this function from a
    // ShowCommand built at runtime, which is exactly the state constructed here.
    const show = arrowShow('fill-red-500')
    expect(show.fill, 'the token resolved at lower time (control)').toBe('#ef4444')
    ;(show as { fill: string | null }).fill = '#zzz'

    const { host, batches } = makeHost()
    addArrowShowLayer(host, show, FC)

    for (const c of batches[0]!.colors) {
      expect(c, 'the flat-white arrow default, not [0,0,0,1]').toEqual([1, 1, 1, 1])
    }
  })
})
