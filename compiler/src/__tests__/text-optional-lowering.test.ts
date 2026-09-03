// `text-optional` — converter → utility → LabelDef IR (#2440).
//
// The runtime half lives in `map/src/text/text-optional-obstacle.test.ts`; this
// file pins the channel that carries the flag to it. Before #2440 the converter
// only WARNED on an authored `true` and put nothing in the IR, which is why the
// campaign audit's "sizes are floors" rule applies here: the visible gap was one
// runtime predicate, and the property still needed three artifacts (converter
// emit + IR field + runtime arm).
//
// Faithful-when-set with a byte-identical ABSENT default, the same shape the
// icon-collision-policy batch uses: only `true` emits. `false` is both the spec
// default and X-GIS's pre-existing pair contract, so a style authoring it
// explicitly (OFM does, on its label_* layers) must stay byte-identical rather
// than gain a field — and must not warn, or the lossless metric regresses on
// styles that changed nothing.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

type TextLabel = { textOptional?: boolean }

function style(layout: Record<string, unknown>) {
  return {
    version: 8,
    sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: { 'icon-image': 'airport_11', 'text-field': '{name}', ...layout },
      },
    ],
  }
}

function convertText(layout: Record<string, unknown>): string {
  return convertMapboxStyle(style(layout) as Parameters<typeof convertMapboxStyle>[0])
}

function compileLabel(layout: Record<string, unknown>): TextLabel {
  const xgis = convertText(layout)
  const scene = lower(new Parser(new Lexer(xgis).tokenize()).parse())
  return (emitCommands(optimize(scene)).shows[0]!.label ?? {}) as TextLabel
}

function warningsOf(layout: Record<string, unknown>): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style(layout) as never, { coverage })
  return coverage.warnings
}

describe('#2440 — text-optional: true threads converter → utility → LabelDef', () => {
  it('emits the label-text-optional utility', () => {
    expect(convertText({ 'text-optional': true })).toContain('label-text-optional')
  })

  it('lowers to LabelDef.textOptional === true', () => {
    expect(compileLabel({ 'text-optional': true }).textOptional).toBe(true)
  })

  it('no longer warns — the property is carried, not deferred', () => {
    // fail-before: the converter pushed "text-optional: true declared but
    // X-GIS' symbol placement always pairs text + icon (deferred …)".
    expect(
      warningsOf({ 'text-optional': true }).filter((w) => w.includes('text-optional')),
    ).toEqual([])
  })
})

// THE CONTROLS. Without them the assertions above are satisfied by a converter
// that emits the utility unconditionally — which would flip every paired symbol
// in every style out of the drop cascade, a far larger behaviour change than the
// property asks for and one no other test in the tree would catch.
describe('#2440 — the absent and false cases stay byte-identical', () => {
  it('absent → no utility and no field', () => {
    expect(convertText({})).not.toContain('label-text-optional')
    expect(compileLabel({}).textOptional).toBeUndefined()
  })

  it('explicit false → no utility, no field, and NO warning', () => {
    // OFM authors `text-optional: false` explicitly. It is the default, so it
    // must cost neither a field nor a conversion note.
    expect(convertText({ 'text-optional': false })).not.toContain('label-text-optional')
    expect(compileLabel({ 'text-optional': false }).textOptional).toBeUndefined()
    expect(
      warningsOf({ 'text-optional': false }).filter((w) => w.includes('text-optional')),
    ).toEqual([])
  })

  it('a non-constant form warns and carries nothing', () => {
    const layout = { 'text-optional': ['step', ['zoom'], false, 14, true] }
    expect(convertText(layout)).not.toContain('label-text-optional')
    expect(compileLabel(layout).textOptional).toBeUndefined()
    const w = warningsOf(layout).filter((s) => s.includes('text-optional'))
    expect(
      w,
      `expected a non-constant warning, got ${JSON.stringify(warningsOf(layout))}`,
    ).toHaveLength(1)
    expect(w[0]).toContain('non-constant')
  })
})
