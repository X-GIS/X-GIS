// #777 cluster I-F — data-driven icon value-forms + icon-translate expr lowering.
//
// Extends the per-feature icon expression pattern (icon-image match/case, iter
// 490) to icon-size and icon-opacity, and adds the icon-translate expression
// form. This test proves the COMPILER half of "evaluate-then-dispatch": the
// non-constant form lowers to a `data-driven` PropertyShape (icon-size /
// icon-opacity) or LabelDef.iconTranslateExpr (icon-translate), AND that the
// lowered AST, when evaluated against a feature's props, yields the correct
// per-feature value — which is exactly what applyFeatureExprs (label-pass.ts)
// does at dispatch. The runtime dispatch half (resolved value → per-vertex
// bytes) is pinned by the packer byte tests + the resolveLabelEffectiveDef
// fall-through test.
//
// Fail-before (icon-size data-driven): pre-I-F the converter WARNED and dropped
// the case/match form — no `label-icon-size-[…]` util, so shapes.icon.iconSize
// stayed constant/null and evaluate() had nothing to run. The updated
// icon-size-validation.test.ts pins that RED→GREEN transition on the converter
// side; here we assert the resulting data-driven shape + its evaluation.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands, evaluate } from '../index'
import type { Expr } from '../parser/ast'

type IconNumShape = { kind: string; expr?: { ast: unknown } } | null
type Show = {
  label?: {
    iconTranslateX?: number
    iconTranslateY?: number
    iconTranslateExpr?: { ast: unknown }
    shapes?: { icon?: { iconSize?: IconNumShape; iconOpacity?: IconNumShape } }
  }
}

function compile(input: { layout?: Record<string, unknown>; paint?: Record<string, unknown> }): {
  show: Show
  warnings: string
} {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [
      {
        id: 'sym',
        type: 'symbol' as const,
        source: 'v',
        'source-layer': 'poi',
        layout: { 'icon-image': 'marker', ...(input.layout ?? {}) },
        ...(input.paint ? { paint: input.paint } : {}),
      },
    ],
  }
  const warnings: string[] = []
  const xgis = convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
  return { show: cmds.shows[0] as unknown as Show, warnings: warnings.join('\n') }
}

describe('icon-size data-driven → LabelShapes.iconSize data-driven (#777 I-F)', () => {
  it('match/get form lowers to a data-driven PropertyShape (was warn+drop)', () => {
    const { show, warnings } = compile({
      layout: { 'icon-size': ['match', ['get', 'class'], 'shop', 0.5, 1] },
    })
    expect(show.label?.shapes?.icon?.iconSize?.kind).toBe('data-driven')
    expect(warnings).not.toContain('icon-size non-constant form not yet supported')
  })

  it('the lowered AST evaluates to the per-feature size (the applyFeatureExprs value)', () => {
    const { show } = compile({
      layout: { 'icon-size': ['match', ['get', 'class'], 'shop', 0.5, 1] },
    })
    const ast = show.label?.shapes?.icon?.iconSize?.expr?.ast as Expr
    expect(ast).toBeTruthy()
    expect(evaluate(ast, { class: 'shop' })).toBeCloseTo(0.5, 6)
    expect(evaluate(ast, { class: 'other' })).toBeCloseTo(1, 6)
  })
})

describe('icon-opacity data-driven → LabelShapes.iconOpacity data-driven (#777 I-F)', () => {
  it('the lowered AST evaluates to the per-feature alpha', () => {
    // Lowering to a data-driven shape already existed (iter 113); I-F adds
    // the runtime consumption. Assert the shape + its per-feature evaluation.
    const { show } = compile({
      paint: { 'icon-opacity': ['match', ['get', 'class'], 'shop', 0.3, 1] },
    })
    expect(show.label?.shapes?.icon?.iconOpacity?.kind).toBe('data-driven')
    const ast = show.label?.shapes?.icon?.iconOpacity?.expr?.ast as Expr
    expect(evaluate(ast, { class: 'shop' })).toBeCloseTo(0.3, 6)
    expect(evaluate(ast, { class: 'x' })).toBeCloseTo(1, 6)
  })
})

describe('icon-translate expression → shape-pair lowering (#777 I-F)', () => {
  it('non-constant form lowers to LabelDef.iconTranslateExpr resolving to [dx,dy]', () => {
    // RED before I-F: converter warned + dropped; no iconTranslateExpr.
    const { show, warnings } = compile({
      paint: {
        'icon-translate': ['case', ['has', 'big'], ['literal', [4, -6]], ['literal', [0, 0]]],
      },
    })
    const ast = show.label?.iconTranslateExpr?.ast as Expr
    expect(ast, 'icon-translate expression should lower to iconTranslateExpr').toBeTruthy()
    expect(warnings).not.toContain('icon-translate non-constant form could not be converted')
    // The resolved shape pair — the [dx,dy] applyFeatureExprs dispatches.
    expect(evaluate(ast, { big: 1 })).toEqual([4, -6])
    expect(evaluate(ast, {})).toEqual([0, 0])
  })

  it('constant [dx,dy] form still lowers to the scalar iconTranslateX/Y pair (byte-identical)', () => {
    const { show } = compile({ paint: { 'icon-translate': [3, -2] } })
    expect(show.label?.iconTranslateX).toBe(3)
    expect(show.label?.iconTranslateY).toBe(-2)
    expect(show.label?.iconTranslateExpr).toBeUndefined()
  })
})
