// Iter 525 regression — pin the OFM label_city / label_town /
// label_village / label_city_capital step-zoom icon-image pipeline.
// All 3 OFM styles author:
//   "icon-image": ["step", ["zoom"], "circle_11_black", 9 or 10, ""]
// At low zoom → render the sprite circle. At z>=threshold → empty
// string = no icon (label-only, matches MapLibre behaviour).
//
// Path: convert/layers.ts → `label-icon-image-[step(zoom, …)]`
// bracket binding → lower stores in labelIconImageExpr → runtime
// `applyFeatureExprs` evaluates the AST with `$zoom` injected via
// `makeEvalProps`. Returns the per-zoom sprite key. Empty string
// returns leave out.iconImage unset → dispatchIcon early-returns.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower, emitCommands, evaluate, makeEvalProps, convertMapboxStyle } from '../index'

function compile(iconImage: unknown) {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [{
      id: 'label_city',
      type: 'symbol' as const,
      source: 'v',
      'source-layer': 'place',
      layout: {
        'icon-image': iconImage,
        'text-field': '{name}',
      },
    }],
  }
  const xgis = convertMapboxStyle(style as never)
  const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
  return cmds.shows[0]
}

describe('icon-image step-zoom — OFM label_city shape (iter 525)', () => {
  it('compiler emits bracket-binding form for step(zoom, ...)', () => {
    const show = compile(['step', ['zoom'], 'circle_11_black', 10, ''])
    const lab = show?.label as { iconImage?: string; iconImageExpr?: { ast: unknown } }
    // No constant fallback — the expression carries the whole behaviour.
    expect(lab?.iconImage).toBeUndefined()
    expect(lab?.iconImageExpr).toBeDefined()
  })

  it('runtime evaluator: z=5 → "circle_11_black" (below threshold)', () => {
    const show = compile(['step', ['zoom'], 'circle_11_black', 10, ''])
    const ast = (show?.label as { iconImageExpr?: { ast: unknown } })?.iconImageExpr?.ast
    expect(ast).toBeDefined()
    const result = evaluate(ast as never, makeEvalProps({ props: { name: 'Seoul' }, cameraZoom: 5 }))
    expect(result).toBe('circle_11_black')
  })

  it('runtime evaluator: z=9 → "circle_11_black" (boundary low side)', () => {
    const show = compile(['step', ['zoom'], 'circle_11_black', 10, ''])
    const ast = (show?.label as { iconImageExpr?: { ast: unknown } })?.iconImageExpr?.ast
    const result = evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 9 }))
    expect(result).toBe('circle_11_black')
  })

  it('runtime evaluator: z=10 → "" (boundary high — sprite drops to label-only)', () => {
    // Mapbox step semantic: input >= stop emits the stop's value.
    // For label_city at z=9 threshold, z>=9 means empty string =
    // no icon. The runtime's length-gate at map.ts:3991 then leaves
    // out.iconImage unset → dispatchIcon early-returns.
    const show = compile(['step', ['zoom'], 'circle_11_black', 10, ''])
    const ast = (show?.label as { iconImageExpr?: { ast: unknown } })?.iconImageExpr?.ast
    const result = evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 10 }))
    expect(result).toBe('')
  })

  it('runtime evaluator: z=18 → "" (well above threshold)', () => {
    const show = compile(['step', ['zoom'], 'circle_11_black', 10, ''])
    const ast = (show?.label as { iconImageExpr?: { ast: unknown } })?.iconImageExpr?.ast
    const result = evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 18 }))
    expect(result).toBe('')
  })

  it('OFM label_city (3-style shape z=9 threshold) → boundary at z=9 returns ""', () => {
    // Real OFM bright/liberty/positron author the 9-threshold form for
    // label_city / label_city_capital. label_town / label_village use
    // a 10-threshold form. Pin both threshold positions explicitly.
    const show = compile(['step', ['zoom'], 'circle_11_black', 9, ''])
    const ast = (show?.label as { iconImageExpr?: { ast: unknown } })?.iconImageExpr?.ast
    expect(evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 8 }))).toBe('circle_11_black')
    expect(evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 9 }))).toBe('')
  })

  it('mixed step+match (multi-arm step) — z<5 default, 5<=z<10 city_dot, z>=10 ""', () => {
    // Defence-in-depth — OFM doesn't author this shape but the
    // step semantic should accumulate stops correctly. Multi-stop
    // pinning lets us catch a regression in the evaluator's loop.
    const show = compile(['step', ['zoom'], 'default_marker', 5, 'city_dot', 10, ''])
    const ast = (show?.label as { iconImageExpr?: { ast: unknown } })?.iconImageExpr?.ast
    expect(evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 0 }))).toBe('default_marker')
    expect(evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 5 }))).toBe('city_dot')
    expect(evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 9 }))).toBe('city_dot')
    expect(evaluate(ast as never, makeEvalProps({ props: {}, cameraZoom: 10 }))).toBe('')
  })
})
