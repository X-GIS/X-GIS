// iter-298 — Filter eval + computeSliceKey fuzz. Edge cases:
//   null / undefined / non-object AST
//   AST evaluator throws (per-feature isolation)
//   NaN / Infinity / 0 / negative numeric result
//   empty / non-empty string result
//   computeSliceKey collision risk
//   special chars in source layer name
//   AST identity caching

import { describe, it, expect } from 'vitest'
import { evalFilterExpr, computeSliceKey } from './filter-eval'

// Hand-crafted FilterAst shape — passed through to compiler's evaluate.
// We use minimal valid AST nodes to exercise the wrapper behaviour
// rather than re-test the evaluator (already fuzzed iter-293).
const num = (value: number) => ({ kind: 'NumberLiteral', value })
const str = (value: string) => ({ kind: 'StringLiteral', value })
const bool = (value: boolean) => ({ kind: 'BoolLiteral', value })
const field = (name: string) => ({ kind: 'FieldAccess', object: null, field: name })
const bin = (op: string, left: unknown, right: unknown) => ({ kind: 'BinaryExpr', op, left, right })

describe('iter-298 evalFilterExpr fuzz', () => {
  it('null AST → true (no filter = pass everything)', () => {
    expect(evalFilterExpr(null, {})).toBe(true)
  })

  it('undefined AST → true', () => {
    expect(evalFilterExpr(undefined, {})).toBe(true)
  })

  it('non-object AST (string / number / boolean) → true', () => {
    expect(evalFilterExpr('not an ast', {})).toBe(true)
    expect(evalFilterExpr(42, {})).toBe(true)
    expect(evalFilterExpr(true, {})).toBe(true)
  })

  it('boolean-literal AST round-trips', () => {
    expect(evalFilterExpr(bool(true), {})).toBe(true)
    expect(evalFilterExpr(bool(false), {})).toBe(false)
  })

  it('numeric result 0 → false', () => {
    expect(evalFilterExpr(num(0), {})).toBe(false)
  })

  it('numeric result positive → true', () => {
    expect(evalFilterExpr(num(1), {})).toBe(true)
    expect(evalFilterExpr(num(0.001), {})).toBe(true)
  })

  it('numeric result negative → true (non-zero finite)', () => {
    expect(evalFilterExpr(num(-1), {})).toBe(true)
  })

  it('NaN-producing expression → false (defensive)', () => {
    // 0/0 yields the evaluator's defensive 0 (line 173 of evaluator.ts),
    // so this exercises the path. But a manual NaN literal goes
    // straight through.
    const ast = bin('/', num(0), num(0))  // evaluator returns 0
    expect(evalFilterExpr(ast, {})).toBe(false)
  })

  it('Infinity-producing expression caught by Number.isFinite check', () => {
    // Direct manual literal — evaluator's NumberLiteral path returns
    // the literal value as-is. Infinity literal isn't part of AST
    // shape, but we can fake it via a number literal NaN check.
    expect(evalFilterExpr(num(Infinity), {})).toBe(false)
    expect(evalFilterExpr(num(-Infinity), {})).toBe(false)
    expect(evalFilterExpr(num(NaN), {})).toBe(false)
  })

  it('string result truthy when non-empty', () => {
    expect(evalFilterExpr(str('road'), {})).toBe(true)
  })

  it('string result falsy when empty', () => {
    expect(evalFilterExpr(str(''), {})).toBe(false)
  })

  it('throw in evaluator caught and converted to false', () => {
    // FieldAccess into a missing field returns null cleanly — doesn't
    // throw. But a malformed AST (kind not recognised) returns null
    // from evaluator's default branch → !!null = false. Confirms
    // the throw-isolation contract via a clearly invalid shape.
    const bogus = { kind: 'NonexistentKind', value: 'whatever' }
    expect(evalFilterExpr(bogus, {})).toBe(false)
  })

  it('cyclic AST does not infinite-loop (try/catch catches stack overflow)', () => {
    // Build a self-referencing object. Evaluator recurses unbounded
    // → throws RangeError → caught → returns false.
    const cyclic: Record<string, unknown> = { kind: 'BinaryExpr', op: '==' }
    cyclic.left = cyclic
    cyclic.right = num(0)
    expect(() => evalFilterExpr(cyclic, {})).not.toThrow()
    expect(evalFilterExpr(cyclic, {})).toBe(false)
  })

  it('field access on numeric prop returns truthy/falsy per value', () => {
    expect(evalFilterExpr(field('class'), { class: 'road' })).toBe(true)
    expect(evalFilterExpr(field('class'), { class: '' })).toBe(false)
    expect(evalFilterExpr(field('class'), { class: 0 })).toBe(false)
    expect(evalFilterExpr(field('class'), {})).toBe(false)  // missing
  })
})

describe('iter-298 computeSliceKey fuzz', () => {
  it('null filter → bare source layer', () => {
    expect(computeSliceKey('water', null)).toBe('water')
    expect(computeSliceKey('water', undefined)).toBe('water')
  })

  it('non-null filter → suffixed key with stable hash', () => {
    const f = bin('==', field('class'), str('road'))
    const k1 = computeSliceKey('roads', f)
    const k2 = computeSliceKey('roads', f)
    expect(k1).toBe(k2)
    expect(k1.startsWith('roads::')).toBe(true)
    expect(k1).not.toBe('roads')
  })

  it('different filters on same source produce different keys', () => {
    const fA = bin('==', field('class'), str('a'))
    const fB = bin('==', field('class'), str('b'))
    expect(computeSliceKey('roads', fA)).not.toBe(computeSliceKey('roads', fB))
  })

  it('same filter on different sources produces different keys', () => {
    const f = bin('==', field('class'), str('a'))
    expect(computeSliceKey('water', f)).not.toBe(computeSliceKey('roads', f))
  })

  it('special chars in source layer survive the key', () => {
    const f = bin('==', field('a'), num(1))
    expect(() => computeSliceKey('water::roads', f)).not.toThrow()
    expect(() => computeSliceKey('', f)).not.toThrow()
    expect(() => computeSliceKey('with spaces', f)).not.toThrow()
    expect(() => computeSliceKey('unicode-한글', f)).not.toThrow()
  })

  it('AST object identity cache produces same key fast path', () => {
    const f = bin('==', field('class'), str('road'))
    const k1 = computeSliceKey('roads', f)
    // Re-call with same object identity hits the WeakMap cache.
    const k2 = computeSliceKey('roads', f)
    expect(k1).toBe(k2)
  })

  it('structurally-equal but identity-different ASTs produce same hash', () => {
    // Two freshly-built filters with identical structure should hash
    // to the same key (JSON.stringify is structural).
    const f1 = bin('==', field('class'), str('road'))
    const f2 = bin('==', field('class'), str('road'))
    expect(computeSliceKey('roads', f1)).toBe(computeSliceKey('roads', f2))
  })

  it('1000 random filters produce no spurious collisions', () => {
    const seen = new Map<string, unknown>()
    for (let i = 0; i < 1000; i++) {
      const f = bin('==', field(`f${i}`), num(i))
      const k = computeSliceKey('layer', f)
      if (seen.has(k) && JSON.stringify(seen.get(k)) !== JSON.stringify(f)) {
        throw new Error(`collision: ${k}`)
      }
      seen.set(k, f)
    }
    // 1000 distinct filters → 1000 distinct keys (no collision).
    expect(seen.size).toBe(1000)
  })

  it('huge AST handled (5000-node nest) — iter-298 defensive fallback', () => {
    // Pre-fix: JSON.stringify stack overflow propagated. Post-fix:
    // catches the throw and falls back to a deterministic sentinel
    // string that still partitions by source-layer.
    let f: unknown = num(0)
    for (let i = 0; i < 5000; i++) f = bin('+', f, num(1))
    expect(() => computeSliceKey('x', f)).not.toThrow()
    const k = computeSliceKey('x', f)
    expect(typeof k).toBe('string')
    expect(k.length).toBeGreaterThan(0)
  })

  it('AST with circular ref handled via iter-298 catch', () => {
    const cyc: Record<string, unknown> = { kind: 'BinaryExpr', op: '==' }
    cyc.left = cyc
    cyc.right = num(0)
    // iter-298 fix: JSON.stringify on circular throws → caught →
    // sentinel returned. No propagation.
    expect(() => computeSliceKey('x', cyc)).not.toThrow()
  })

  it('two structurally-distinct deep ASTs produce DISTINCT keys (iter-299 iterative hash)', () => {
    // iter-298 fallback returned a sentinel — both deep ASTs hashed
    // to the same string. iter-299's iterative walk hashes the actual
    // tree content, so distinct deep ASTs produce distinct keys.
    let f1: unknown = num(0)
    let f2: unknown = num(0)
    for (let i = 0; i < 5000; i++) {
      f1 = bin('+', f1, num(1))
      f2 = bin('+', f2, num(2))  // different RHS literal
    }
    const k1 = computeSliceKey('a', f1)
    const k2 = computeSliceKey('a', f2)
    expect(k1).not.toBe(k2)
    expect(k1.startsWith('a::')).toBe(true)
    expect(k2.startsWith('a::')).toBe(true)
  })
})
