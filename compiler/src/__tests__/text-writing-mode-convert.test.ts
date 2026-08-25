// T4 CJK vertical P1 (#2051) — Mapbox `text-writing-mode` threaded end-to-end:
//   text-writing-mode → label-writing-mode-vertical → LabelDef.writingMode
//
// The design doc (docs/plans/2026-08-24-cjk-vertical-text.md §12 P1) fixes the
// ARRAY SEMANTICS this gate pins: the style value is an ordered orientation
// PRIORITY LIST, but D7 ships one orientation, so P1 reads it as a SET —
// `vertical` ANYWHERE in the array ⇒ `writingMode: 'vertical'`; `["horizontal"]`
// and an absent property ⇒ unset, which is what keeps every style that does not
// author the property byte-identical (ADR-0012 §4.3). Honouring the priority
// ORDER is a recorded `partial` (doc §14.2), not a silent drop — so the
// order-insensitivity below is an ASSERTED decision, not an accident.
//
// P1 changes no pixels: nothing reads LabelDef.writingMode yet (doc §12 P2
// owns the layout). This gate proves the converter EMITS and the IR CARRIES.

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

describe('text-writing-mode threading (converter + IR)', () => {
  it('emits label-writing-mode-vertical for text-writing-mode: ["vertical"]', () => {
    expect(convert(symbolLayer({ 'text-writing-mode': ['vertical'] }))).toContain(
      'label-writing-mode-vertical',
    )
  })

  // Set semantics: `vertical` present anywhere wins, regardless of position.
  it('emits for ["horizontal", "vertical"] — vertical PRESENT, not first', () => {
    expect(convert(symbolLayer({ 'text-writing-mode': ['horizontal', 'vertical'] }))).toContain(
      'label-writing-mode-vertical',
    )
  })

  it('emits for ["vertical", "horizontal"] — same utility, order not honoured (doc §14.2)', () => {
    expect(convert(symbolLayer({ 'text-writing-mode': ['vertical', 'horizontal'] }))).toContain(
      'label-writing-mode-vertical',
    )
  })

  // v8 strict `["literal", [...]]` wrap must peel before the membership test —
  // without the unwrap the whole tuple is inspected and NOTHING is emitted
  // (the text-variable-anchor regression class, layers-symbol.ts:635).
  it('unwraps the v8 ["literal", […]] strict wrapper', () => {
    expect(convert(symbolLayer({ 'text-writing-mode': ['literal', ['vertical']] }))).toContain(
      'label-writing-mode-vertical',
    )
  })

  it('IR LabelDef carries writingMode="vertical" from the emitted utility', () => {
    const node = lowerUtilities('label-[.name] label-writing-mode-vertical')
    expect(node.label).toBeDefined()
    expect(node.label!.writingMode).toBe('vertical')
  })

  // BYTE-IDENTITY ARM (ADR-0012 §4.3). `["horizontal"]` is the spec default and
  // an absent property is the overwhelming real-style case — both must emit NO
  // utility and leave the IR field unset, or every audited style's output moves.
  it('["horizontal"] (spec default) emits NO writing-mode utility', () => {
    expect(convert(symbolLayer({ 'text-writing-mode': ['horizontal'] }))).not.toContain(
      'label-writing-mode',
    )
  })

  it('absent text-writing-mode emits NO utility and leaves IR unset', () => {
    expect(convert(symbolLayer())).not.toContain('label-writing-mode')
    const node = lowerUtilities('label-[.name]')
    expect(node.label).toBeDefined()
    expect(node.label!.writingMode).toBeUndefined()
  })

  // The X-GIS0006 label catch-all (lower-label.ts) exists so a converter
  // emission with no lowering arm fails loudly instead of dropping the value.
  // If the arm were missing, this diagnostic would name the utility.
  it('the emitted utility has a lowering arm (no X-GIS0006 drop warning)', () => {
    const src = `
      source vt { type: geojson }
      layer lbl {
        source: vt
        | label-[.name] label-writing-mode-vertical
      }
    `
    const program = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
    const diagnostics = lower(program).diagnostics ?? []
    expect(diagnostics.filter((d) => d.code === 'X-GIS0006')).toEqual([])
  })
})
