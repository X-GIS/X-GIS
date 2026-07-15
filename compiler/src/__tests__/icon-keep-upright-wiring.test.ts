// #777 cluster I-B — icon-keep-upright lowering (converter → LabelDef).
//
// Mapbox `icon-keep-upright` (layout, boolean, default true) flips a line-placed
// icon 180° when the segment tangent would render it upside-down — the icon twin
// of `text-keep-upright`. This cluster lowers the CONSTANT form to
// LabelDef.iconKeepUpright, consumed in the label-pass dispatchIcon rotation
// fold (map/src/render/passes/label-pass.ts). Mirrors the text keep-upright
// plumbing: `icon-keep-upright: true` → `label-icon-keep-upright`,
// `icon-keep-upright: false` → `label-icon-keep-upright-false`.
//
// DEFAULT CAUTION (binding decision, gap-matrix §"Cluster I-B"): Mapbox's spec
// default is `true`, but X-GIS activates the fold ONLY on an EXPLICITLY authored
// value. An ABSENT property emits no knob and leaves iconKeepUpright undefined,
// so today's always-follow-tangent render stays byte-identical (the
// icon-allow-overlap absent-default convention). Flipping the absent-default
// would need its own §5 before/after sweep.
//
// Value-forms boundary: constant only here. Non-constant (zoom-interp /
// data-driven) forms are NOT lowered — they warn and skip.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

type IconLabel = { iconKeepUpright?: boolean }

function styleWith(layout: Record<string, unknown>) {
  return {
    version: 8,
    sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: { 'icon-image': 'oneway', 'symbol-placement': 'line', ...layout },
      },
    ],
  }
}

function compileLabel(layout: Record<string, unknown>): IconLabel {
  const xgis = convertMapboxStyle(styleWith(layout) as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const shows = emitCommands(optimize(scene)).shows
  return (shows[0]!.label ?? {}) as IconLabel
}

function convertText(layout: Record<string, unknown>): string {
  return convertMapboxStyle(styleWith(layout) as Parameters<typeof convertMapboxStyle>[0])
}

function warningsFor(layout: Record<string, unknown>): string[] {
  const warnings: string[] = []
  convertMapboxStyle(styleWith(layout) as Parameters<typeof convertMapboxStyle>[0], {
    coverage: { sources: [], layers: [], warnings },
  })
  return warnings
}

describe('icon-keep-upright lowering — converter → LabelDef (#777 I-B)', () => {
  it('icon-keep-upright: true → LabelDef.iconKeepUpright === true', () => {
    // RED before I-B: the converter dropped icon-keep-upright entirely, so the
    // value never reached the LabelDef → iconKeepUpright is undefined.
    expect(compileLabel({ 'icon-keep-upright': true }).iconKeepUpright).toBe(true)
  })

  it('emits label-icon-keep-upright for a constant true', () => {
    expect(convertText({ 'icon-keep-upright': true })).toContain('label-icon-keep-upright')
  })

  it('icon-keep-upright: false → LabelDef.iconKeepUpright === false (explicit opt-out recorded)', () => {
    expect(compileLabel({ 'icon-keep-upright': false }).iconKeepUpright).toBe(false)
  })

  it('emits label-icon-keep-upright-false for a constant false', () => {
    expect(convertText({ 'icon-keep-upright': false })).toContain('label-icon-keep-upright-false')
  })

  it('absent → iconKeepUpright undefined (byte-identical always-follow-tangent default)', () => {
    // DEFAULT CAUTION: the spec default is true, but an absent property emits no
    // knob and activates nothing — today's render is preserved exactly.
    expect(compileLabel({}).iconKeepUpright).toBeUndefined()
    expect(convertText({})).not.toContain('label-icon-keep-upright')
  })

  it('absent → no icon-keep-upright warning', () => {
    expect(warningsFor({}).filter((w) => w.includes('icon-keep-upright'))).toEqual([])
  })

  it('OFM literal-wrapped constant (["literal", true]) → iconKeepUpright true', () => {
    expect(compileLabel({ 'icon-keep-upright': ['literal', true] }).iconKeepUpright).toBe(true)
  })

  it('non-constant form → warn + skip (no knob, iconKeepUpright undefined)', () => {
    // Data-driven / expression forms are not lowered: they warn and leave the
    // field undefined so the runtime keeps the byte-identical default.
    const expr = { 'icon-keep-upright': ['case', ['get', 'flip'], true, false] }
    expect(compileLabel(expr).iconKeepUpright).toBeUndefined()
    expect(convertText(expr)).not.toContain('label-icon-keep-upright')
    const hits = warningsFor(expr).filter((w) => w.includes('icon-keep-upright'))
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('non-constant')
  })
})
