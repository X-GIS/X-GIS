// Mapbox-spec conformance for text label positioning, end-to-end:
//
//   Mapbox style JSON   →  convertMapboxStyle  →  xgis utility source
//                       →  Lexer / Parser     →  lower (IR LabelDef)
//
// User asserted (2026-05-12): "Label text anchor must be Mapbox style
// based, and so must the start position." Both the converter and the
// runtime already implement the 9-way anchor + text-variable-anchor +
// em-unit offsets correctly (layers.ts:353-410, text-stage.ts:465-485),
// but no test pinned the whole chain — so a future refactor could
// silently regress to e.g. "5-way anchor", off-by-axis offsets, or a
// pixel/em unit confusion. This file locks the contract.
//
// What's verified:
//   – Each of the 9 anchor values flows through to LabelDef.anchor
//     and appears in anchorCandidates.
//   – text-variable-anchor preserves priority order; static anchor
//     equals the first candidate (so consumers that don't honour
//     variable placement still pick the author's intended fallback).
//   – text-offset values land in LabelDef.offset VERBATIM (em units;
//     the runtime multiplies by sizePx at draw time).
//   – text-translate values land in LabelDef.translate VERBATIM (px).
//   – Omitting text-anchor leaves LabelDef.anchor undefined so the
//     runtime defaults to 'center' (matches Mapbox default).
//   – text-justify all four values map 1-to-1.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import type { LabelDef } from '../ir/render-node'

interface SymbolLayout {
  'text-field'?: unknown
  'text-anchor'?: unknown
  'text-offset'?: unknown
  'text-justify'?: unknown
  [k: string]: unknown
}
interface SymbolPaint { 'text-translate'?: unknown; [k: string]: unknown }

function labelDefFor(layout: SymbolLayout, paint: SymbolPaint = {}): LabelDef {
  const xgis = convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'mapbox://x.pmtiles' } },
    layers: [{
      id: 'sym', type: 'symbol', source: 'v', 'source-layer': 'pts',
      layout: { 'text-field': '{name}', ...layout } as never,
      paint: paint as never,
    }],
  })
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  const scene = lower(program)
  const node = scene.renderNodes.find(n => n.label !== undefined)
  expect(node, 'expected one renderNode with a label').toBeDefined()
  return node!.label!
}

const ANCHORS = [
  'center', 'top', 'bottom', 'left', 'right',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
] as const

describe('Mapbox text-anchor → LabelDef.anchor (9-way)', () => {
  for (const a of ANCHORS) {
    it(`text-anchor: "${a}" → LabelDef.anchor === "${a}"`, () => {
      const lbl = labelDefFor({ 'text-anchor': a })
      expect(lbl.anchor).toBe(a)
      // Single-anchor labels leave `anchorCandidates` undefined; the
      // runtime falls back to `[anchor ?? 'center']` at draw time
      // (text-stage.ts:453-455). The array form is reserved for the
      // text-variable-anchor case (length ≥ 2) so the IR stays small
      // for the common single-anchor case.
      expect(lbl.anchorCandidates).toBeUndefined()
    })
  }
})

describe('Mapbox text-variable-anchor → LabelDef.anchorCandidates', () => {
  it('preserves priority order; static anchor equals the first candidate', () => {
    const lbl = labelDefFor({
      'text-anchor': ['top', 'bottom', 'top-left'],
    })
    expect(lbl.anchor).toBe('top')
    expect(lbl.anchorCandidates).toEqual(['top', 'bottom', 'top-left'])
  })

  it('drops invalid entries silently and keeps valid ones in order', () => {
    const lbl = labelDefFor({
      'text-anchor': ['top', 'middle' /* invalid */, 'bottom'],
    })
    expect(lbl.anchor).toBe('top')
    expect(lbl.anchorCandidates).toEqual(['top', 'bottom'])
  })
})

describe('Mapbox text-anchor default (omitted) → undefined in IR', () => {
  it('runtime falls back to center; IR leaves the field unset', () => {
    const lbl = labelDefFor({})  // no text-anchor
    expect(lbl.anchor).toBeUndefined()
    // anchorCandidates is also unset — when the runtime sees neither,
    // it uses the Mapbox default of "center" (text-stage.ts:455).
    expect(lbl.anchorCandidates).toBeUndefined()
  })
})

describe('Mapbox text-offset (em units) → LabelDef.offset', () => {
  it('positive [dx, dy] preserved verbatim — runtime multiplies by sizePx', () => {
    const lbl = labelDefFor({ 'text-offset': [0.5, 1.25] })
    expect(lbl.offset).toEqual([0.5, 1.25])
  })

  it('negative values survive the bracket-binding round-trip', () => {
    // text-offset: [0, -0.2] is by far the most common form in real
    // Mapbox styles — labels sit above POIs by 0.2 em.
    const lbl = labelDefFor({ 'text-offset': [-0.5, -0.2] })
    expect(lbl.offset).toEqual([-0.5, -0.2])
  })

  it('zero on either axis is dropped (no offset emitted on that axis)', () => {
    // The converter omits `label-offset-x-0` when dx === 0 to keep the
    // utility string short. The lower pass therefore reports offset
    // with the absent axis as 0 — equivalent to authoring [0, dy].
    const lbl = labelDefFor({ 'text-offset': [0, 1.5] })
    expect(lbl.offset).toEqual([0, 1.5])
  })

  it('omitted text-offset → LabelDef.offset undefined', () => {
    const lbl = labelDefFor({})
    expect(lbl.offset).toBeUndefined()
  })
})

describe('Mapbox text-translate (paint, pixels) → LabelDef.translate', () => {
  it('px values preserved verbatim — stacks on top of em-unit offset', () => {
    const lbl = labelDefFor(
      { 'text-offset': [0, -0.2] },
      { 'text-translate': [0, -8] },
    )
    expect(lbl.offset).toEqual([0, -0.2])    // em-units
    expect(lbl.translate).toEqual([0, -8])   // pixels
  })
})

describe('Mapbox text-justify → LabelDef.justify (4-way)', () => {
  for (const j of ['auto', 'left', 'center', 'right'] as const) {
    it(`text-justify: "${j}" → LabelDef.justify === "${j}"`, () => {
      const lbl = labelDefFor({ 'text-justify': j })
      expect(lbl.justify).toBe(j)
    })
  }

  it('omitted text-justify → LabelDef.justify undefined (runtime defaults to "center")', () => {
    const lbl = labelDefFor({})
    expect(lbl.justify).toBeUndefined()
  })
})

describe('Mapbox text-variable-anchor (real layout property) → anchorCandidates', () => {
  it('the dedicated property (NOT array-in-text-anchor) populates candidates', () => {
    // Real OFM Bright / Liberty / demotiles styles put the candidate
    // list in `text-variable-anchor`, not as an array in `text-anchor`.
    // Before the fix the converter only read `text-anchor`, so every
    // such POI / place label silently fell back to the default center
    // anchor — the user-reported "label not on point" bug.
    const lbl = labelDefFor({ 'text-variable-anchor': ['top', 'bottom', 'left', 'right'] })
    expect(lbl.anchor).toBe('top')
    expect(lbl.anchorCandidates).toEqual(['top', 'bottom', 'left', 'right'])
  })
})

describe('Mapbox text-radial-offset → LabelDef.radialOffset', () => {
  it('constant em preserved verbatim (runtime applies fromRadialOffset)', () => {
    const lbl = labelDefFor({
      'text-variable-anchor': ['top', 'bottom'],
      'text-radial-offset': 0.8,
    })
    expect(lbl.radialOffset).toBe(0.8)
    expect(lbl.anchorCandidates).toEqual(['top', 'bottom'])
  })

  it('omitted text-radial-offset → LabelDef.radialOffset undefined', () => {
    const lbl = labelDefFor({ 'text-variable-anchor': ['top', 'bottom'] })
    expect(lbl.radialOffset).toBeUndefined()
  })
})

describe('Mapbox text-variable-anchor-offset → LabelDef.variableAnchorOffset', () => {
  it('zips ordered anchors with per-anchor em offsets, including negatives', () => {
    const lbl = labelDefFor({
      'text-variable-anchor-offset': [
        'top', [0, 1],
        'left', [1, 0],
        'bottom-right', [-0.5, -0.5],
      ],
    })
    expect(lbl.variableAnchorOffset).toEqual([
      ['top', [0, 1]],
      ['left', [1, 0]],
      ['bottom-right', [-0.5, -0.5]],
    ])
    // The vao anchors double as the variable-placement candidates.
    expect(lbl.anchorCandidates).toEqual(['top', 'left', 'bottom-right'])
  })
})
