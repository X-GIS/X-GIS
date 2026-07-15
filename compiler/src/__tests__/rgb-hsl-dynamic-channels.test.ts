// Mapbox `rgb`/`rgba`/`hsl`/`hsla` colour constructors with PER-FEATURE
// (data-driven) channels — Phase III expression/colour finish.
//
// FAIL-BEFORE (pre-change behaviour these tests pin the fix against):
//   * Converter: a dynamic `["rgb", ["get","r"], …]` hit rgbHandler's
//     non-constant branch → `warnings.push("… with non-constant channels
//     not converted")` + `return null`, so the colour DROPPED entirely.
//     `hsl`/`hsla` had no expression handler at all → generic "Expression
//     not converted" → also dropped.
//   * Evaluator: `callBuiltin` had no rgb/rgba/hsl/hsla case → the #1066
//     throwing default fired ("unknown function 'rgb'"), caught by the
//     render-hot-path try/catch → authored-fallback colour, never the
//     computed one.
//
// AFTER: the converter emits a runtime `rgb(…)`/`hsl(…)` call for the
// non-constant form (expr-string.ts rgb/hslHandler); the evaluator
// resolves it per feature to a hex string (evaluator-helpers.ts
// callBuiltin). Constant channels still fold to a hex at convert time.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'
import { callBuiltin, BUILTIN_FN_NAMES } from '../eval/evaluator-helpers'
import { exprToXgis } from '../convert/expressions'
import { withPragma } from './_pragma'

function evalExpr(src: string, props: Record<string, unknown> = {}): unknown {
  const tokens = new Lexer(withPragma('let __x = ' + src)).tokenize()
  const ast = new Parser(tokens).parse()
  const stmt = ast.body[0]
  if (stmt.kind !== 'LetStatement') throw new Error('expected LetStatement')
  return evaluate(stmt.value as never, makeEvalProps({ props }))
}

describe('rgb / rgba dynamic channels — converter emit', () => {
  it('FAIL-BEFORE: dynamic ["rgb", ["get","r"], …] now emits rgb(…) instead of dropping', () => {
    const w: string[] = []
    const out = exprToXgis(['rgb', ['get', 'r'], ['get', 'g'], ['get', 'b']], w)
    expect(out).not.toBeNull()
    expect(out).toMatch(/^rgb\(/)
    // the old "not converted" drop warning must be gone
    expect(w.join('\n')).not.toMatch(/non-constant channels not converted/)
  })

  it('dynamic rgba (get channels + alpha) emits rgba(…)', () => {
    const w: string[] = []
    const out = exprToXgis(['rgba', ['get', 'r'], ['get', 'g'], ['get', 'b'], 0.5], w)
    expect(out).not.toBeNull()
    expect(out).toMatch(/^rgba\(/)
  })

  it('mixed constant + dynamic channels emit the call (not the constant fast-path)', () => {
    const w: string[] = []
    const out = exprToXgis(['rgb', 255, ['get', 'g'], 0], w)
    expect(out).toMatch(/^rgb\(/)
  })

  it('regression: all-constant ["rgb", 255, 0, 0] still hex-encodes at convert time', () => {
    expect(exprToXgis(['rgb', 255, 0, 0], [])).toBe('#ff0000')
  })
})

describe('rgb / rgba runtime evaluator builtin', () => {
  it('rgb(255, 0, 0) → #ff0000', () => {
    expect(evalExpr('rgb(255, 0, 0)')).toBe('#ff0000')
  })

  it('rgb clamps out-of-range channels to [0,255]', () => {
    expect(evalExpr('rgb(300, -5, 0)')).toBe('#ff0000')
  })

  it('rgba(255, 0, 0, 0.5) → #ff0000 with mid alpha', () => {
    expect(evalExpr('rgba(255, 0, 0, 0.5)')).toMatch(/^#ff0000[78]0$/i)
  })

  it('per-feature rgb(.r, .g, .b) resolves against the feature props', () => {
    expect(evalExpr('rgb(.r, .g, .b)', { r: 0, g: 255, b: 0 })).toBe('#00ff00')
  })
})

describe('hsl / hsla dynamic channels — converter emit', () => {
  it('FAIL-BEFORE: dynamic ["hsl", ["get","h"], …] now emits hsl(…) instead of dropping', () => {
    const w: string[] = []
    const out = exprToXgis(['hsl', ['get', 'h'], 100, 50], w)
    expect(out).not.toBeNull()
    expect(out).toMatch(/^hsl\(/)
  })

  it('regression: all-constant ["hsl", 0, 100, 50] hex-encodes in expression context', () => {
    // Pre-change hsl had no expression handler at all — a constant hsl
    // inside e.g. a ["case", …] arm dropped. The new hslHandler fixes
    // both the constant and dynamic forms.
    expect(exprToXgis(['hsl', 0, 100, 50], [])).toBe('#ff0000')
  })

  it('arity check: ["hsl", 0, 100] (2 channels) → null + warning', () => {
    const w: string[] = []
    expect(exprToXgis(['hsl', 0, 100], w)).toBeNull()
    expect(w.join('\n')).toMatch(/expected 3 channels/)
  })
})

describe('hsl / hsla runtime evaluator builtin', () => {
  it('hsl(0, 100, 50) → #ff0000 (pure red)', () => {
    expect(evalExpr('hsl(0, 100, 50)')).toBe('#ff0000')
  })

  it('hsl(120, 100, 50) → #00ff00 (pure green)', () => {
    expect(evalExpr('hsl(120, 100, 50)')).toBe('#00ff00')
  })

  it('hsla(0, 100, 50, 0.5) → #ff0000 with mid alpha', () => {
    expect(evalExpr('hsla(0, 100, 50, 0.5)')).toMatch(/^#ff0000[78]0$/i)
  })

  it('per-feature hsl(.h, .s, .l) resolves against the feature props', () => {
    expect(evalExpr('hsl(.h, .s, .l)', { h: 120, s: 100, l: 50 })).toBe('#00ff00')
  })
})

describe('colour-constructor builtins — registry consistency (#1066 invariant)', () => {
  it('rgb / rgba / hsl / hsla are in BUILTIN_FN_NAMES', () => {
    for (const n of ['rgb', 'rgba', 'hsl', 'hsla']) {
      expect(BUILTIN_FN_NAMES.has(n)).toBe(true)
    }
  })

  it('callBuiltin dispatches them without hitting the throwing default', () => {
    for (const n of ['rgb', 'rgba', 'hsl', 'hsla']) {
      expect(() => callBuiltin(n, [10, 20, 30, 0.5])).not.toThrow()
    }
  })
})

describe('end-to-end: converter emit → evaluator round-trip', () => {
  it('dynamic rgb converts then evaluates to the per-feature hex', () => {
    const w: string[] = []
    const xgis = exprToXgis(['rgb', ['get', 'r'], ['get', 'g'], ['get', 'b']], w)
    expect(xgis).not.toBeNull()
    // rgb(10, 20, 30) → 0x0a 0x14 0x1e
    expect(evalExpr(xgis as string, { r: 10, g: 20, b: 30 })).toBe('#0a141e')
  })

  it('dynamic hsl converts then evaluates to the per-feature hex', () => {
    const w: string[] = []
    const xgis = exprToXgis(['hsl', ['get', 'h'], ['get', 's'], ['get', 'l']], w)
    expect(xgis).not.toBeNull()
    expect(evalExpr(xgis as string, { h: 120, s: 100, l: 50 })).toBe('#00ff00')
  })
})
