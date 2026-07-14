// Phase S Batch 4 — Mapbox `symbol-z-order` threaded end-to-end:
//   symbol-z-order → label-z-order-<v> → LabelDef.symbolZOrder
//
// This gate proves the converter EMITS the right utility for each enum
// value, that the IR carries it through the lower pass, and — critically
// — that a style that does NOT author symbol-z-order emits NOTHING (the
// default reproduces today's ordering byte-for-byte; the runtime
// prepare() pass keeps its legacy reverse-layer / sortKey path). The
// runtime ordering pass itself is covered in the runtime text-stage
// suite (symbol-z-order viewport-y / source draw-order tests).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { withPragma } from './_pragma'

function convert(layer: Record<string, unknown>): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [layer],
  } as never)
}

function symbolLayer(extraLayout: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lbl',
    type: 'symbol',
    source: 'v',
    'source-layer': 'places',
    layout: { 'text-field': '{name}', ...extraLayout },
    paint: { 'text-color': '#000' },
  }
}

/** Lower a single xgis DSL layer and return its first renderNode. */
function lowerUtilities(utilities: string) {
  const src = `
    source vt { type: geojson }
    layer lbl {
      source: vt
      | ${utilities}
    }
  `
  const program = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
  return lower(program).renderNodes[0]!
}

describe('symbol-z-order threading (converter + IR)', () => {
  it('emits label-z-order-viewport-y for symbol-z-order: viewport-y', () => {
    expect(convert(symbolLayer({ 'symbol-z-order': 'viewport-y' }))).toContain(
      'label-z-order-viewport-y',
    )
  })

  it('emits label-z-order-source for symbol-z-order: source', () => {
    expect(convert(symbolLayer({ 'symbol-z-order': 'source' }))).toContain('label-z-order-source')
  })

  it('emits label-z-order-auto for symbol-z-order: auto (explicit)', () => {
    expect(convert(symbolLayer({ 'symbol-z-order': 'auto' }))).toContain('label-z-order-auto')
  })

  it('IR LabelDef carries symbolZOrder=viewport-y from the emitted utility', () => {
    const node = lowerUtilities('label-[.name] label-z-order-viewport-y')
    expect(node.label).toBeDefined()
    expect(node.label!.symbolZOrder).toBe('viewport-y')
  })

  it('IR LabelDef carries symbolZOrder=source from the emitted utility', () => {
    const node = lowerUtilities('label-[.name] label-z-order-source')
    expect(node.label!.symbolZOrder).toBe('source')
  })

  it('IR LabelDef carries symbolZOrder=auto from the emitted utility', () => {
    const node = lowerUtilities('label-[.name] label-z-order-auto')
    expect(node.label!.symbolZOrder).toBe('auto')
  })

  // v8 strict ["literal", "viewport-y"] wrap resolves before the enum match.
  it('unwraps the v8 ["literal", …] strict wrapper', () => {
    expect(convert(symbolLayer({ 'symbol-z-order': ['literal', 'viewport-y'] }))).toContain(
      'label-z-order-viewport-y',
    )
  })

  // DEFAULT / absent — byte-identical to today: no utility, IR field unset
  // ⇒ runtime keeps its legacy reverse-layer / sortKey ordering.
  it('default (no symbol-z-order) emits NO z-order utility and leaves IR unset', () => {
    expect(convert(symbolLayer())).not.toContain('label-z-order')
    const node = lowerUtilities('label-[.name]')
    expect(node.label).toBeDefined()
    expect(node.label!.symbolZOrder).toBeUndefined()
  })

  it('invalid enum emits NO utility (warns instead — see warn test)', () => {
    expect(convert(symbolLayer({ 'symbol-z-order': 'nonsense' }))).not.toContain('label-z-order')
  })
})
