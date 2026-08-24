// #2008 C-tier: MapLibre expression residuals — split/join string ops,
// to-rgba colour coercion, and the `object` type assert.
//
// FAIL-BEFORE (pre-change behaviour these tests pin the fix against):
//   * Converter: `["split", …]` / `["join", …]` / `["to-rgba", …]` /
//     `["object", …]` were absent from EXPR_HANDLERS → exprToXgis fell to
//     the generic catch-all: `warnings.push("Expression not converted: …")`
//     + `return null`. A text-field authoring `["join", ["split", …], …]`
//     dropped the WHOLE label (layers-helpers.ts textFieldToXgisExpr
//     returns null for a non-convertible array, and the symbol layer skips
//     entirely — layer-converters/symbol.ts).
//   * Evaluator: `callBuiltin` had no split/join/to_rgba cases → the #1066
//     throwing default (`ir/validate-fncalls.ts`) would reject a
//     hand-authored `split(...)` / `join(...)` / `to_rgba(...)` xgis call
//     at compile time as an unknown function.
//
// AFTER: split/join lower to the `split(…)` / `join(…)` runtime builtins
// (expr-string.ts splitHandler/joinHandler; eval/evaluator-helpers.ts
// callBuiltin); to-rgba constant-folds to a literal array at convert time
// or emits a `to_rgba(…)` runtime call for data-driven colours; `object`
// reuses typeCoercionHandler (same fallback-chain treatment as its
// `string`/`number`/`boolean` siblings, which the FAIL-BEFORE section
// below confirms are ALREADY supported — contrary to issue #2008's
// premise that they currently warn).
//
// Spec citations: @maplibre/maplibre-gl-style-spec 24.8.5,
// node_modules/.bun/@maplibre+maplibre-gl-style-spec@24.8.5/node_modules/
// @maplibre/maplibre-gl-style-spec/src/expression/compound_expression.ts
//   split (511-514):  (ctx, [s, delim]) => s.evaluate(ctx).split(delim.evaluate(ctx))
//   join  (516-520):  (ctx, [arr, delim]) => arr.evaluate(ctx).join(delim.evaluate(ctx))
//   to-rgba (228-234): (ctx, [v]) => { const [r,g,b,a] = v.evaluate(ctx).rgb; return [r*255, g*255, b*255, a] }
// and .../src/expression/definitions/coercion.ts (the `to-color` array-arg
// branch normalises rgba array input the same way, confirming the 0-255
// r/g/b convention is symmetric across to-color / rgb() / to-rgba).

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'
import { callBuiltin, BUILTIN_FN_NAMES } from '../eval/evaluator-helpers'
import { exprToXgis } from '../convert/expressions'
import { textFieldToXgisExpr } from '../convert/layers-helpers'

function evalExpr(src: string, props: Record<string, unknown> = {}): unknown {
  const ast = new Parser(new Lexer(src).tokenize()).parseSingleExpression()
  return evaluate(ast as never, makeEvalProps({ props }))
}

describe('["split"] / ["join"] — converter emit (#2008 C-tier)', () => {
  it('FAIL-BEFORE: ["split", …] now converts instead of the generic catch-all', () => {
    const w: string[] = []
    const out = exprToXgis(['split', ['get', 'name'], ','], w)
    expect(out).toBe('split(.name, ",")')
    expect(w.join('\n')).not.toMatch(/Expression not converted/)
  })

  it('FAIL-BEFORE: ["join", …] now converts instead of the generic catch-all', () => {
    const w: string[] = []
    const out = exprToXgis(['join', ['literal', ['a', 'b']], ' / '], w)
    expect(out).toBe('join(["a", "b"], " / ")')
    expect(w.join('\n')).not.toMatch(/Expression not converted/)
  })

  it('WITNESS (issue #2008): ["join", ["split", ["get","name"], ","], " / "] full conversion', () => {
    const w: string[] = []
    const out = exprToXgis(['join', ['split', ['get', 'name'], ','], ' / '], w)
    expect(out).toBe('join(split(.name, ","), " / ")')
    expect(w).toEqual([])
  })

  it('WITNESS: the same expression as a text-field no longer drops the label', () => {
    const w: string[] = []
    const out = textFieldToXgisExpr(['join', ['split', ['get', 'name'], ','], ' / '], w)
    expect(out).toBe('join(split(.name, ","), " / ")')
  })

  it('WITNESS: full pipeline evaluates "a,b,c" → "a / b / c"', () => {
    const out = exprToXgis(['join', ['split', ['get', 'name'], ','], ' / '], [])
    expect(out).not.toBeNull()
    expect(evalExpr(out!, { name: 'a,b,c' })).toBe('a / b / c')
  })

  it('arity check: ["split", str] (1 arg) → null + warning', () => {
    const w: string[] = []
    expect(exprToXgis(['split', ['get', 'name']], w)).toBeNull()
    expect(w.join('\n')).toMatch(/Malformed \["split"\]/)
  })

  it('arity check: ["join", arr] (1 arg) → null + warning', () => {
    const w: string[] = []
    expect(exprToXgis(['join', ['literal', ['a']]], w)).toBeNull()
    expect(w.join('\n')).toMatch(/Malformed \["join"\]/)
  })
})

describe('split / join — runtime evaluator builtin (#2008 C-tier)', () => {
  it('split("a,b,c", ",") → ["a","b","c"]', () => {
    expect(callBuiltin('split', ['a,b,c', ','])).toEqual(['a', 'b', 'c'])
  })

  it('split("", ",") → [""] (JS String#split semantics — MapLibre inherits this verbatim)', () => {
    expect(callBuiltin('split', ['', ','])).toEqual([''])
  })

  it('split("abc", "x") — delimiter not found → ["abc"] (whole string, one element)', () => {
    expect(callBuiltin('split', ['abc', 'x'])).toEqual(['abc'])
  })

  it('split("abc", "") — empty delimiter → per-character split ["a","b","c"]', () => {
    expect(callBuiltin('split', ['abc', ''])).toEqual(['a', 'b', 'c'])
  })

  it('split(non-string, ",") → null (X-GIS fail-soft; spec throws, we do not)', () => {
    expect(callBuiltin('split', [42, ','])).toBeNull()
  })

  it('join(["a","b","c"], " / ") → "a / b / c"', () => {
    expect(callBuiltin('join', [['a', 'b', 'c'], ' / '])).toBe('a / b / c')
  })

  it('join([], ",") — empty array → "" (empty string, not null)', () => {
    expect(callBuiltin('join', [[], ','])).toBe('')
  })

  it('join([1,2,3], ",") — non-string elements stringify via native Array#join → "1,2,3"', () => {
    expect(callBuiltin('join', [[1, 2, 3], ','])).toBe('1,2,3')
  })

  it('join(non-array, ",") → null', () => {
    expect(callBuiltin('join', ['not-an-array', ','])).toBeNull()
  })

  it('per-feature split(.name, .sep) resolves against feature props', () => {
    expect(evalExpr('split(.name, .sep)', { name: 'x|y|z', sep: '|' })).toEqual(['x', 'y', 'z'])
  })
})

describe('["to-rgba"] — converter emit (#2008 C-tier)', () => {
  it('FAIL-BEFORE: ["to-rgba", …] now converts instead of the generic catch-all', () => {
    const w: string[] = []
    const out = exprToXgis(['to-rgba', '#ff0000'], w)
    expect(out).not.toBeNull()
    expect(w.join('\n')).not.toMatch(/Expression not converted/)
  })

  it('constant hex ["to-rgba", "#ff0000"] folds to a literal array [255, 0, 0, 1] at convert time', () => {
    expect(exprToXgis(['to-rgba', '#ff0000'], [])).toBe('[255, 0, 0, 1]')
  })

  it('constant 8-digit hex carries alpha through resolveColorToRgba', () => {
    // 0x80 / 255 = 0.5019607843137255 — same float the spec's own
    // Color object would carry (no rounding applied to alpha).
    expect(exprToXgis(['to-rgba', '#ff000080'], [])).toBe('[255, 0, 0, 0.5019607843137255]')
  })

  it('constant CSS name folds via resolveColor', () => {
    expect(exprToXgis(['to-rgba', 'red'], [])).toBe('[255, 0, 0, 1]')
  })

  it('dynamic ["to-rgba", ["get","c"]] emits a runtime to_rgba(…) call', () => {
    const w: string[] = []
    const out = exprToXgis(['to-rgba', ['get', 'c']], w)
    expect(out).toBe('to_rgba(.c)')
  })

  it('arity check: ["to-rgba"] (0 args) → null + warning', () => {
    const w: string[] = []
    expect(exprToXgis(['to-rgba'], w)).toBeNull()
    expect(w.join('\n')).toMatch(/Malformed \["to-rgba"\]/)
  })
})

describe('to_rgba — runtime evaluator builtin (#2008 C-tier)', () => {
  it('to_rgba("#00ff00") → [0, 255, 0, 1]', () => {
    expect(callBuiltin('to_rgba', ['#00ff00'])).toEqual([0, 255, 0, 1])
  })

  it('to_rgba of an unresolvable string → null (report, not lie — see colorRamp precedent)', () => {
    expect(callBuiltin('to_rgba', ['not-a-colour'])).toBeNull()
  })

  it('to_rgba of a non-string → null', () => {
    expect(callBuiltin('to_rgba', [42])).toBeNull()
  })

  it('dynamic to_rgba(.c) resolves against feature props', () => {
    expect(evalExpr('to_rgba(.c)', { c: '#0000ff' })).toEqual([0, 0, 255, 1])
  })
})

describe('["object"] — converter emit (#2008 C-tier)', () => {
  it('FAIL-BEFORE: ["object", …] now converts instead of the generic catch-all', () => {
    const w: string[] = []
    const out = exprToXgis(['object', ['properties']], w)
    expect(out).toBe('properties()')
    expect(w.join('\n')).not.toMatch(/Expression not converted/)
  })

  it('fallback chain ["object", a, b] → a ?? b (identical treatment to string/number/boolean)', () => {
    const w: string[] = []
    expect(exprToXgis(['object', ['get', 'a'], ['get', 'b']], w)).toBe('.a ?? .b')
  })
})

describe('#2008 registry consistency (#1066 invariant)', () => {
  it('split / join / to_rgba are in BUILTIN_FN_NAMES', () => {
    for (const n of ['split', 'join', 'to_rgba']) {
      expect(BUILTIN_FN_NAMES.has(n)).toBe(true)
    }
  })

  it('callBuiltin dispatches them without hitting the throwing default', () => {
    expect(() => callBuiltin('split', ['a', ','])).not.toThrow()
    expect(() => callBuiltin('join', [['a'], ','])).not.toThrow()
    expect(() => callBuiltin('to_rgba', ['#fff'])).not.toThrow()
  })
})
