// Phase S Batch 2 — per-layer threshold overrides threaded end-to-end:
//   • line-round-limit  → stroke-roundlimit-N  → StrokeNode.roundLimit
//   • text-max-angle    → label-max-angle-N    → LabelDef.maxAngle
//
// Both were previously HARD-CODED fixed thresholds (line-round-limit was
// dropped as an ignored paint prop; text-max-angle only surfaced a gap
// warning). This gate proves the converter EMITS the right utility for a
// Mapbox input AND that the IR carries the value through the lower pass,
// and — critically — that a style that does NOT author the property emits
// NOTHING (the default reproduces today's behaviour byte-for-byte, no
// regression for styles that don't use the prop).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

function convert(layer: Record<string, unknown>): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [layer],
  } as never)
}

function lineLayer(extraLayout: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'road', type: 'line', source: 'v', 'source-layer': 'roads',
    layout: { 'line-join': 'round', ...extraLayout },
    paint: { 'line-color': '#000', 'line-width': 2 },
  }
}

function symbolLayer(extraLayout: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lbl', type: 'symbol', source: 'v', 'source-layer': 'roads',
    layout: { 'text-field': '{name}', 'symbol-placement': 'line', ...extraLayout },
    paint: { 'text-color': '#000' },
  }
}

/** Lower a single-line xgis DSL layer and return its first renderNode. */
function lowerUtilities(utilities: string) {
  const src = `
    source vt { type: geojson }
    layer road {
      source: vt
      | ${utilities}
    }
  `
  const program = new Parser(new Lexer(src).tokenize()).parse()
  return lower(program).renderNodes[0]!
}

describe('line-round-limit threading (converter + IR)', () => {
  it('emits stroke-roundlimit-N for an authored line-round-limit', () => {
    expect(convert(lineLayer({ 'line-round-limit': 2 }))).toContain('stroke-roundlimit-2')
  })

  it('IR StrokeNode carries roundLimit from the emitted utility', () => {
    const node = lowerUtilities('stroke-#000 stroke-2 stroke-round-join stroke-roundlimit-2')
    expect(node.stroke.roundLimit).toBe(2)
  })

  // DEFAULT / absent — byte-identical to today: no utility, IR field unset.
  it('default (no line-round-limit) emits NO roundlimit utility and leaves IR unset', () => {
    expect(convert(lineLayer())).not.toContain('stroke-roundlimit')
    const node = lowerUtilities('stroke-#000 stroke-2 stroke-round-join')
    expect(node.stroke.roundLimit).toBeUndefined()
  })

  it('non-positive line-round-limit is ignored (no utility emitted)', () => {
    expect(convert(lineLayer({ 'line-round-limit': 0 }))).not.toContain('stroke-roundlimit')
    expect(convert(lineLayer({ 'line-round-limit': -1 }))).not.toContain('stroke-roundlimit')
  })
})

describe('text-max-angle threading (converter + IR)', () => {
  it('emits label-max-angle-N for an authored text-max-angle', () => {
    expect(convert(symbolLayer({ 'text-max-angle': 30 }))).toContain('label-max-angle-30')
  })

  it('IR LabelDef carries maxAngle from the emitted utility', () => {
    const node = lowerUtilities('label-[.name] label-along-path label-max-angle-30')
    expect(node.label).toBeDefined()
    expect(node.label!.maxAngle).toBe(30)
  })

  // The spec default (45) IS authored here → still wires (a renderer that
  // historically didn't clamp now opts into the 45° gate).
  it('text-max-angle: 45 (spec default, authored) still emits the utility', () => {
    expect(convert(symbolLayer({ 'text-max-angle': 45 }))).toContain('label-max-angle-45')
  })

  // DEFAULT / absent — byte-identical to today: no utility, IR field unset
  // ⇒ runtime applies NO angular gate (historical no-clamp behaviour).
  it('default (no text-max-angle) emits NO max-angle utility and leaves IR unset', () => {
    expect(convert(symbolLayer())).not.toContain('label-max-angle')
    const node = lowerUtilities('label-[.name] label-along-path')
    expect(node.label).toBeDefined()
    expect(node.label!.maxAngle).toBeUndefined()
  })
})
