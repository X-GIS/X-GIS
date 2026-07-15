// #777 cluster I-A — icon-text-fit + icon-text-fit-padding lowering
// (converter → LabelDef).
//
// Mapbox `icon-text-fit` (layout enum: none | width | height | both) stretches
// the icon sprite quad to wrap the PAIRED label's shaped text bbox — the
// shield/badge-background case. This cluster replaces the old warn-and-drop with
// a real emit: the constant enum → `label-icon-text-fit-<v>` → LabelDef.iconTextFit,
// and the optional `icon-text-fit-padding` [t,r,b,l] → per-side utilities →
// LabelDef.iconTextFitPadding. `none` / absent emit nothing (spec default = native
// sprite size, byte-identical). Non-constant forms warn once (icon-padding precedent).
//
// This pins the converter+lower half (emit + no-warn); the runtime stretch
// (bbox → quad dims) is pinned by runtime/src/engine/sprite/icon-text-fit-wiring.test.ts.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

type IconLabel = {
  iconTextFit?: 'width' | 'height' | 'both'
  iconTextFitPadding?: [number, number, number, number]
}

function styleOf(layout: Record<string, unknown>): Parameters<typeof convertMapboxStyle>[0] {
  return {
    version: 8,
    sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: { 'text-field': '{name}', 'icon-image': 'shield', ...layout },
      },
    ],
  } as Parameters<typeof convertMapboxStyle>[0]
}

function compileLabel(layout: Record<string, unknown>): IconLabel {
  const xgis = convertMapboxStyle(styleOf(layout))
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const shows = emitCommands(optimize(scene)).shows
  return (shows[0]!.label ?? {}) as IconLabel
}

function convertText(layout: Record<string, unknown>): string {
  return convertMapboxStyle(styleOf(layout))
}

function warningsOf(layout: Record<string, unknown>): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(styleOf(layout), { coverage })
  return coverage.warnings
}

describe('icon-text-fit lowering — converter → LabelDef (#777 I-A)', () => {
  it('icon-text-fit: "both" → LabelDef.iconTextFit === "both"', () => {
    // RED before I-A: the converter only warned; the value never reached LabelDef.
    expect(compileLabel({ 'icon-text-fit': 'both' }).iconTextFit).toBe('both')
  })

  it('icon-text-fit: "width" / "height" lower to the matching enum', () => {
    expect(compileLabel({ 'icon-text-fit': 'width' }).iconTextFit).toBe('width')
    expect(compileLabel({ 'icon-text-fit': 'height' }).iconTextFit).toBe('height')
  })

  it('emits label-icon-text-fit-<v> and does NOT warn (was warn-and-drop before I-A)', () => {
    expect(convertText({ 'icon-text-fit': 'both' })).toContain('label-icon-text-fit-both')
    const w = warningsOf({ 'icon-text-fit': 'both' })
    expect(w.some((s) => s.includes('icon-text-fit'))).toBe(false)
  })

  it('icon-text-fit: "none" → no field, no knob, no warn (spec default, byte-identical)', () => {
    expect(compileLabel({ 'icon-text-fit': 'none' }).iconTextFit).toBeUndefined()
    expect(convertText({ 'icon-text-fit': 'none' })).not.toContain('label-icon-text-fit')
    expect(warningsOf({ 'icon-text-fit': 'none' }).some((s) => s.includes('icon-text-fit'))).toBe(
      false,
    )
  })

  it('absent icon-text-fit → iconTextFit undefined (byte-identical to the pre-#777 path)', () => {
    expect(compileLabel({}).iconTextFit).toBeUndefined()
    expect(convertText({})).not.toContain('label-icon-text-fit')
  })

  it('icon-text-fit-padding [1,2,3,4] with a fit → LabelDef.iconTextFitPadding [t,r,b,l]', () => {
    const label = compileLabel({ 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 2, 3, 4] })
    expect(label.iconTextFitPadding).toEqual([1, 2, 3, 4])
  })

  it('padding emits per-side utilities in [t,r,b,l] order', () => {
    const src = convertText({ 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 2, 3, 4] })
    expect(src).toContain('label-icon-text-fit-padding-t-1')
    expect(src).toContain('label-icon-text-fit-padding-r-2')
    expect(src).toContain('label-icon-text-fit-padding-b-3')
    expect(src).toContain('label-icon-text-fit-padding-l-4')
  })

  it('zero padding sides emit nothing; a partial [0,5,0,5] reconstructs with 0 defaults', () => {
    const label = compileLabel({ 'icon-text-fit': 'both', 'icon-text-fit-padding': [0, 5, 0, 5] })
    expect(label.iconTextFitPadding).toEqual([0, 5, 0, 5])
    const src = convertText({ 'icon-text-fit': 'both', 'icon-text-fit-padding': [0, 5, 0, 5] })
    expect(src).not.toContain('label-icon-text-fit-padding-t-')
    expect(src).toContain('label-icon-text-fit-padding-r-5')
  })

  it('default padding [0,0,0,0] with a fit → no padding utilities (byte-identical)', () => {
    expect(
      convertText({ 'icon-text-fit': 'both', 'icon-text-fit-padding': [0, 0, 0, 0] }),
    ).not.toContain('label-icon-text-fit-padding')
  })

  it('padding WITHOUT a fit (icon-text-fit none/absent) → padding is inert, nothing emitted', () => {
    expect(convertText({ 'icon-text-fit-padding': [3, 3, 3, 3] })).not.toContain(
      'label-icon-text-fit-padding',
    )
    expect(
      convertText({ 'icon-text-fit': 'none', 'icon-text-fit-padding': [3, 3, 3, 3] }),
    ).not.toContain('label-icon-text-fit-padding')
  })

  it('OFM literal-wrapped forms: ["literal","both"] enum + ["literal",[..]] padding', () => {
    const label = compileLabel({
      'icon-text-fit': ['literal', 'both'],
      'icon-text-fit-padding': ['literal', [2, 2, 2, 2]],
    })
    expect(label.iconTextFit).toBe('both')
    expect(label.iconTextFitPadding).toEqual([2, 2, 2, 2])
  })

  it('negative padding side clamps to 0 with a warning', () => {
    const label = compileLabel({ 'icon-text-fit': 'both', 'icon-text-fit-padding': [-4, 2, 0, 0] })
    expect(label.iconTextFitPadding).toEqual([0, 2, 0, 0])
    expect(
      warningsOf({ 'icon-text-fit': 'both', 'icon-text-fit-padding': [-4, 2, 0, 0] }).some((s) =>
        s.includes('icon-text-fit-padding'),
      ),
    ).toBe(true)
  })

  it('non-constant icon-text-fit (expression) → warns, no field', () => {
    const layout = { 'icon-text-fit': ['get', 'fit'] }
    expect(compileLabel(layout).iconTextFit).toBeUndefined()
    expect(
      warningsOf(layout).some((s) => s.includes('icon-text-fit') && s.includes('non-constant')),
    ).toBe(true)
  })

  it('unknown enum value → warns (typo guard)', () => {
    expect(
      warningsOf({ 'icon-text-fit': 'stretch' }).some(
        (s) => s.includes('icon-text-fit') && s.includes('not a valid enum'),
      ),
    ).toBe(true)
  })
})
