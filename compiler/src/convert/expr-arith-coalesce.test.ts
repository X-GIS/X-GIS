// Regression: arithmetic-operator arity + ternary-arm coalesce binding.
//
// BUG A — the arithmetic case for `+ - * / %` shared the comparison
// branch's `if (v.length !== 3) return null`, so ONLY the exact
// 2-operand form converted. Mapbox spec: `+`/`*` are variadic and `-`
// has a 1-arg (unary negation) form. The non-2-arg forms returned null
// and silently collapsed the whole containing case/interpolate/paint.
//
// BUG B — coalesce / to-* arms were joined with ` ?? ` UNPARENTHESIZED.
// The parser puts ternary ABOVE `??` (parser.ts parseExpr vs
// parseCoalesce), so a non-final arm that is a ternary
// (`cond ? a : b ?? fb`) mis-binds to `cond ? a : (b ?? fb)` — the
// coalesce fallback migrates into the case else-branch.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from './expressions'
import { evaluate } from '../eval/evaluator'
import { parseExpressionString } from '../parser/parser'

/** Parse an xgis expression string and return its AST node. */
function parseExpr(src: string): { kind: string } {
  return parseExpressionString(src)
}

describe('BUG A — arithmetic operator arity (variadic + / *, unary -)', () => {
  it('["*", 2, 3, 4] folds to a chained product (not null)', () => {
    const out = exprToXgis(['*', 2, 3, 4], [])
    expect(out).not.toBeNull()
    // Chained product parses + evaluates left-associative to 24.
    expect(evaluate(parseExpr(out!) as never, {})).toBe(24)
  })

  it('["+", 1, 2, 3] folds to a chained sum (not null)', () => {
    const out = exprToXgis(['+', 1, 2, 3], [])
    expect(out).not.toBeNull()
    expect(evaluate(parseExpr(out!) as never, {})).toBe(6)
  })

  it('["-", ["get", "h"]] emits a unary negation', () => {
    const out = exprToXgis(['-', ['get', 'h']], [])
    expect(out).not.toBeNull()
    expect(evaluate(parseExpr(out!) as never, { h: 7 })).toBe(-7)
  })

  it('control: ["*", ["get", "scale"], 2] still converts + evaluates', () => {
    const out = exprToXgis(['*', ['get', 'scale'], 2], [])
    expect(out).not.toBeNull()
    expect(evaluate(parseExpr(out!) as never, { scale: 5 })).toBe(10)
  })

  it('binary ["-", a, b] subtracts; "/" and "%" stay exact-2', () => {
    expect(evaluate(parseExpr(exprToXgis(['-', 10, 4], [])!) as never, {})).toBe(6)
    expect(evaluate(parseExpr(exprToXgis(['/', 12, 4], [])!) as never, {})).toBe(3)
    expect(evaluate(parseExpr(exprToXgis(['%', 7, 3], [])!) as never, {})).toBe(1)
  })
})

describe('BUG B — ternary arm must not swallow the ?? fallback', () => {
  it('coalesce with a leading case arm parses as a top-level ??', () => {
    const out = exprToXgis(
      ['coalesce', ['case', ['has', 'x'], ['get', 'x'], null], ['get', 'y']],
      [],
    )
    expect(out).not.toBeNull()
    // The top of the tree must be the coalesce (BinaryExpr op ??), NOT
    // a ConditionalExpr (which is what the unparenthesized arm produced
    // pre-fix: `cond ? a : (b ?? fb)`).
    expect(parseExpr(out!).kind).toBe('BinaryExpr')
  })

  it('coalesce fallback fires when the case arm resolves to null', () => {
    // ["case", true, null, "B"] → null (cond true → first value null).
    // Coalesce must then fall through to "FB". Pre-fix the "FB" migrated
    // into the case else-branch and the whole expression yielded null.
    const out = exprToXgis(['coalesce', ['case', ['==', 1, 1], null, 'B'], 'FB'], [])
    expect(out).not.toBeNull()
    expect(evaluate(parseExpr(out!) as never, {})).toBe('FB')
  })
})
