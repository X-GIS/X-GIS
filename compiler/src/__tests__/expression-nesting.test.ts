// Recursion depth + cycle guards for the Mapbox expression converter.
// `exprToXgis` is purely recursive; without a depth cap, pathological
// inputs (deep case ladders, recursive let bodies, malformed cyclic
// JSON injected by a preprocessor) could blow the JS stack and crash
// the whole compile. The MAX_EXPR_DEPTH=256 guard truncates the
// subtree with a warning while keeping the rest of the style usable.

import { describe, expect, it } from 'vitest'
import { exprToXgis } from '../convert/expressions'

// Build a deeply nested case ladder: case(true, case(true, …, base), base).
function deepCase(n: number, base: unknown = 0): unknown {
  if (n <= 0) return base
  return ['case', true, deepCase(n - 1, base), base]
}

// Interpolate stops where each value is itself a nested match.
function deepInterpolate(n: number): unknown {
  return ['interpolate', ['linear'], ['zoom'], 0, deepCase(n), 10, deepCase(n, 1)]
}

describe('expression nesting + depth guards', () => {
  it('handles depth 10 without warning', () => {
    const warnings: string[] = []
    const result = exprToXgis(deepCase(10), warnings)
    expect(result).not.toBeNull()
    expect(warnings.some((w) => w.includes('depth'))).toBe(false)
  })

  it('handles depth 50 without warning', () => {
    const warnings: string[] = []
    const result = exprToXgis(deepCase(50), warnings)
    expect(result).not.toBeNull()
    expect(warnings.some((w) => w.includes('depth'))).toBe(false)
  })

  it('handles depth 200 without warning', () => {
    const warnings: string[] = []
    const result = exprToXgis(deepCase(200), warnings)
    expect(result).not.toBeNull()
    expect(warnings.some((w) => w.includes('depth'))).toBe(false)
  })

  it('truncates at depth > 256 with a warning instead of stack overflow', () => {
    const warnings: string[] = []
    // 500 levels — far beyond MAX_EXPR_DEPTH=256.
    const result = exprToXgis(deepCase(500), warnings)
    // Result might still emit (outer levels) but with at least one
    // truncation warning surfaced.
    expect(warnings.some((w) => w.includes('depth exceeded'))).toBe(true)
    // Critically: must not throw / crash the test runner.
    expect(typeof result === 'string' || result === null).toBe(true)
  })

  it('handles deeply nested interpolate over deep case values', () => {
    const warnings: string[] = []
    const result = exprToXgis(deepInterpolate(20), warnings)
    expect(result).not.toBeNull()
    expect(warnings.some((w) => w.includes('depth'))).toBe(false)
  })

  it('does not stack-overflow on circular let body (defensive)', () => {
    // Construct a self-referential let — bindings.set(x → ["var", "x"])
    // means substituteVars(["var","x"]) returns ["var","x"] (no
    // further work because the var is in the map and not an array
    // with a sub-tree). The visited WeakSet still prevents an
    // infinite loop if a preprocessor builds a cyclic array.
    const cyc: unknown[] = ['let', 'x', ['var', 'x'], ['var', 'x']]
    const warnings: string[] = []
    expect(() => exprToXgis(cyc, warnings)).not.toThrow()
  })

  it('does not stack-overflow on manually-injected cyclic array (defensive)', () => {
    const cycle: unknown[] = ['case']
    // Build a self-referencing array — JSON.stringify would throw on
    // this, but the user might construct one in code before calling
    // convertMapboxStyle. The visited WeakSet must prevent the
    // recursion from blowing the stack.
    cycle.push(true, cycle, 0)
    const warnings: string[] = []
    expect(() => exprToXgis(cycle, warnings)).not.toThrow()
  })
})

describe('nested `let` substitution (#2340)', () => {
  it('a plain single-level let still converts exactly as before (control)', () => {
    // Same shape as the "unique binding names" case in
    // let-duplicate-bindings.test.ts — no nested let involved, so
    // this path never touches the new descent and must be unaffected.
    const warnings: string[] = []
    const result = exprToXgis(['let', 'r', 1, 's', 5, ['+', ['var', 'r'], ['var', 's']]], warnings)
    expect(result).toBe('(1 + 5)')
    expect(warnings).toEqual([])
  })

  it('an outer let binding reaches a var inside a nested let body', () => {
    // The witness from #2340: a bare `["var", "a"]` two `let`s deep
    // used to stop at the inner `let` and come back unresolved,
    // which failed the containing `+` and collapsed the whole
    // expression to null.
    const warnings: string[] = []
    const result = exprToXgis(
      ['let', 'a', 1, ['let', 'b', 2, ['+', ['var', 'a'], ['var', 'b']]]],
      warnings,
    )
    expect(result).not.toBeNull()
    expect(result).toBe('(1 + 2)')
    expect(warnings).toEqual([])
  })

  it('an inner let name shadows an outer one of the same name', () => {
    // Proves the merge order (inner names set ON TOP of the outer
    // copy) rather than accidentally passing because the two values
    // happen to agree.
    const warnings: string[] = []
    const result = exprToXgis(['let', 'a', 1, ['let', 'a', 2, ['var', 'a']]], warnings)
    expect(result).toBe('2')
    expect(warnings).toEqual([])
  })

  it('an inner let binding VALUE expression sees the outer scope, not the inner one', () => {
    // The outer-vs-merged asymmetry: `b`'s value expression is
    // evaluated in the ENCLOSING scope (sees `a`), while `b` itself
    // is only visible inside the inner let's own body.
    const warnings: string[] = []
    const result = exprToXgis(
      ['let', 'a', 1, ['let', 'b', ['var', 'a'], ['var', 'b']]],
      warnings,
    )
    expect(result).toBe('1')
    expect(warnings).toEqual([])
  })
})
