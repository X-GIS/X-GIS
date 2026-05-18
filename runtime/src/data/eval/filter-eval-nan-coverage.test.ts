// Pin NaN-as-false contract for evalFilterExpr (PMTiles slice / MVT
// worker hot path). Pre-fix `result !== 0` accepted NaN as truthy;
// a filter expression that evaluated to NaN (typically arithmetic
// on a missing/null property) bypassed the authored predicate and
// let every feature through. Mirror of compiler-side toBool fix
// (iter 373) and applyFilter NaN gate (iter 372).

import { describe, it, expect } from 'vitest'
import { evalFilterExpr } from './filter-eval'

// Mock AST evaluator: build minimal NumberLiteral that the compiler
// evaluator returns as the literal number. evalFilterExpr coerces
// numeric results via Number.isFinite gate post-fix.
const numLit = (value: number): unknown => ({ kind: 'NumberLiteral', value })

describe('evalFilterExpr NaN-as-false contract', () => {
  it('NaN result → false (was true via NaN !== 0)', () => {
    expect(evalFilterExpr(numLit(NaN), {})).toBe(false)
  })

  it('Infinity result → false', () => {
    expect(evalFilterExpr(numLit(Infinity), {})).toBe(false)
    expect(evalFilterExpr(numLit(-Infinity), {})).toBe(false)
  })

  it('non-zero finite number → true (regression guard)', () => {
    expect(evalFilterExpr(numLit(42), {})).toBe(true)
  })

  it('zero → false (regression guard)', () => {
    expect(evalFilterExpr(numLit(0), {})).toBe(false)
  })

  it('null ast → true (no filter = accept all)', () => {
    expect(evalFilterExpr(null, {})).toBe(true)
  })
})
