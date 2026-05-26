// ═══════════════════════════════════════════════════════════════════
// canonicalJsonStringify — order-stable serialiser (US-010 prep)
// ═══════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest'
import { canonicalJsonStringify } from './canonical-json'

describe('canonicalJsonStringify — Phase 2.5 US-010 cache-stability primitive', () => {
  it('emits primitives identically to JSON.stringify', () => {
    expect(canonicalJsonStringify(null)).toBe('null')
    expect(canonicalJsonStringify(true)).toBe('true')
    expect(canonicalJsonStringify(false)).toBe('false')
    expect(canonicalJsonStringify(42)).toBe('42')
    expect(canonicalJsonStringify(3.14)).toBe('3.14')
    expect(canonicalJsonStringify('hello')).toBe('"hello"')
    expect(canonicalJsonStringify('he"llo')).toBe('"he\\"llo"')
  })

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]')
  })

  it('sorts object keys lexicographically — DIFFERS from JSON.stringify insertion order', () => {
    const objA = { b: 1, a: 2, c: 3 }
    const objB = { c: 3, a: 2, b: 1 }
    // Both inputs use a different insertion order; canonical output is identical.
    expect(canonicalJsonStringify(objA)).toBe('{"a":2,"b":1,"c":3}')
    expect(canonicalJsonStringify(objB)).toBe('{"a":2,"b":1,"c":3}')
    expect(canonicalJsonStringify(objA)).toBe(canonicalJsonStringify(objB))
  })

  it('recurses with sorted keys at every nesting level', () => {
    const x = { z: { b: 2, a: 1 }, a: { y: 4, x: 3 } }
    expect(canonicalJsonStringify(x)).toBe('{"a":{"x":3,"y":4},"z":{"a":1,"b":2}}')
  })

  it('handles a matchExpr-shaped IR node deterministically', () => {
    // Mirrors the shape canonical-JSON will hash inside matchArmsKey
    // (post-retarget): an Expr with `op`, `type`, `scrutinee`, `cases`,
    // `default` fields whose nested objects must serialise stably.
    const matchA = {
      op: 'matchExpr',
      type: { kind: 'vec', n: 4, elem: 'f32' },
      scrutinee: { op: 'param', type: { kind: 'scalar', scalar: 'u32' }, name: 'class_id' },
      cases: [
        [0, { op: 'lit', type: { kind: 'vec', n: 4, elem: 'f32' }, value: 0 }],
        [1, { op: 'lit', type: { kind: 'vec', n: 4, elem: 'f32' }, value: 1 }],
      ],
      default: { op: 'lit', type: { kind: 'vec', n: 4, elem: 'f32' }, value: -1 },
    }
    // Same logical Node, different key insertion order — must produce
    // the IDENTICAL canonical string. This is the variant-cache stability
    // invariant: a Node serialised twice in different orders must hash
    // to the same key, or the engine fragments the pipeline cache.
    const matchB = {
      default: { value: -1, type: { elem: 'f32', n: 4, kind: 'vec' }, op: 'lit' },
      cases: [
        [0, { value: 0, type: { elem: 'f32', n: 4, kind: 'vec' }, op: 'lit' }],
        [1, { value: 1, type: { elem: 'f32', n: 4, kind: 'vec' }, op: 'lit' }],
      ],
      scrutinee: { name: 'class_id', type: { scalar: 'u32', kind: 'scalar' }, op: 'param' },
      type: { elem: 'f32', n: 4, kind: 'vec' },
      op: 'matchExpr',
    }
    expect(canonicalJsonStringify(matchA)).toBe(canonicalJsonStringify(matchB))
  })

  it('drops undefined / function / symbol like JSON.stringify', () => {
    expect(canonicalJsonStringify({ a: undefined, b: 1, c: () => 0, d: 2 })).toBe('{"b":1,"d":2}')
    expect(canonicalJsonStringify([1, undefined, 3])).toBe('[1,null,3]')
  })

  it('emits NaN / Infinity as null (JSON.stringify parity)', () => {
    expect(canonicalJsonStringify(NaN)).toBe('null')
    expect(canonicalJsonStringify(Infinity)).toBe('null')
  })

  it('throws on object cycles', () => {
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    expect(() => canonicalJsonStringify(cyc)).toThrow(/cycle detected/)
  })

  it('is reusable across sequential calls (cycle-detection set scoped per call)', () => {
    const x = { a: 1 }
    canonicalJsonStringify(x)
    // Second call on the same object would have tripped a cycle if the
    // WeakSet was function-scoped and never cleared. Guards against the
    // accidental-globals trap.
    expect(canonicalJsonStringify(x)).toBe('{"a":1}')
  })
})
