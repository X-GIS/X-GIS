// #777 cluster I-D — icon-padding lowering (converter → LabelDef).
//
// Mapbox `icon-padding` (layout, number, default 2, min 0, units px) is the
// per-icon collision-box padding. This cluster lowers the CONSTANT form to
// LabelDef.iconPadding, threaded to IconStage's collision box (replacing the
// fixed `2 * dpr` at icon-stage.ts:290). Mirrors text-padding's `label-padding`
// plumbing: a knob is emitted ONLY for a non-default value, so authoring the
// spec default 2 (OFM Bright road_oneway) stays byte-identical — no knob, no
// LabelDef field, the stage applies 2.
//
// Value-forms boundary: constant only here. Zoom-interp / data-driven forms are
// NOT lowered (they warn) — data-driven icon value-forms belong to cluster I-F.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

type IconLabel = { iconPadding?: number }

function compileLabel(layout: Record<string, unknown>): IconLabel {
  const style = {
    version: 8,
    sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: { 'icon-image': 'pin', ...layout },
      },
    ],
  }
  const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const shows = emitCommands(optimize(scene, ast)).shows
  return (shows[0]!.label ?? {}) as IconLabel
}

function convertText(layout: Record<string, unknown>): string {
  const style = {
    version: 8,
    sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: { 'icon-image': 'pin', ...layout },
      },
    ],
  }
  return convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
}

describe('icon-padding lowering — converter → LabelDef (#777 I-D)', () => {
  it('icon-padding: 7 → LabelDef.iconPadding === 7', () => {
    // RED before I-D: the converter only warned; the value never reached the
    // LabelDef → iconPadding is undefined.
    expect(compileLabel({ 'icon-padding': 7 }).iconPadding).toBe(7)
  })

  it('emits label-icon-padding-<N> for a non-default constant', () => {
    // RED before I-D: no knob was emitted (warn-only).
    expect(convertText({ 'icon-padding': 7 })).toContain('label-icon-padding-7')
  })

  it('absent → iconPadding undefined (the icon-stage collision box applies the spec default 2)', () => {
    expect(compileLabel({}).iconPadding).toBeUndefined()
  })

  it('icon-padding: 2 (spec default) → no field, no knob (byte-identical to absent)', () => {
    expect(compileLabel({ 'icon-padding': 2 }).iconPadding).toBeUndefined()
    expect(convertText({ 'icon-padding': 2 })).not.toContain('label-icon-padding')
  })

  it('icon-padding: 0 → iconPadding === 0 (author meant no padding; 0 is spec-valid)', () => {
    expect(compileLabel({ 'icon-padding': 0 }).iconPadding).toBe(0)
  })

  it('negative → clamped to 0 (Mapbox spec min 0), mirroring text-padding', () => {
    expect(compileLabel({ 'icon-padding': -3 }).iconPadding).toBe(0)
  })

  it('OFM literal-wrapped default (["literal", 2]) → no field (byte-identical)', () => {
    expect(compileLabel({ 'icon-padding': ['literal', 2] }).iconPadding).toBeUndefined()
  })
})
