// ═══════════════════════════════════════════════════════════════════
// matchArmsKey — Phase 2.5 US-010 prep coverage
// ═══════════════════════════════════════════════════════════════════
//
// Pins the variant-cache hash boundary across the in-flight Phase
// 2.5 migration:
//   - Legacy string inputs hash identically pre and post US-010 prep
//     (every existing caller today passes strings — output bytes
//     must NOT drift, or the variant pool re-keys industry-wide).
//   - Node-shaped inputs canonicalise via canonicalJsonStringify
//     so two semantically equivalent matchExpr Nodes with different
//     key insertion orders hash to the same key (cache stability).
//   - Mixed input (one string, one Node) cleanly combines.

import { describe, it, expect } from 'vitest'
import { matchArmsKey } from './shader-gen-helpers'

describe('matchArmsKey — legacy string-input invariants', () => {
  it('returns "" for both undefined', () => {
    expect(matchArmsKey(undefined, undefined)).toBe('')
  })

  it('returns "" for both empty strings (no behavior change vs pre-migration)', () => {
    expect(matchArmsKey('', '')).toBe('')
  })

  it('hash is non-empty for a real match preamble string', () => {
    const fill = 'var _mcF1: vec4f = vec4f(0.0, 0.0, 0.0, 0.0); if (field0_id == 0u) { _mcF1 = vec4f(0.78, 0.91, 0.74, 1.0); }'
    expect(matchArmsKey(fill, undefined)).toMatch(/^\|m:[a-z0-9]+$/)
  })

  it('same string content → same hash (stable)', () => {
    const a = matchArmsKey('if (x == 0u) { c = R; }', 'if (y == 1u) { d = B; }')
    const b = matchArmsKey('if (x == 0u) { c = R; }', 'if (y == 1u) { d = B; }')
    expect(a).toBe(b)
  })

  it('different fill / stroke content → different hashes', () => {
    const a = matchArmsKey('if (x == 0u) { c = R; }', undefined)
    const b = matchArmsKey('if (x == 1u) { c = R; }', undefined)
    expect(a).not.toBe(b)
  })
})

describe('matchArmsKey — Node input (US-010 prep)', () => {
  it('accepts a NodeLike-shaped value (object with .expr) and produces a stable hash', () => {
    const node = {
      expr: {
        op: 'matchExpr',
        type: { kind: 'vec', n: 4, elem: 'f32' },
        scrutinee: { op: 'param', type: { kind: 'scalar', scalar: 'u32' }, name: 'class_id' },
        cases: [[0, { op: 'lit', type: { kind: 'vec', n: 4, elem: 'f32' }, value: 0 }]],
        default: { op: 'lit', type: { kind: 'vec', n: 4, elem: 'f32' }, value: -1 },
      },
    }
    expect(matchArmsKey(node, undefined)).toMatch(/^\|m:[a-z0-9]+$/)
  })

  it('two Nodes with different key insertion order hash to the SAME key (canonical-JSON invariant)', () => {
    // The same logical matchExpr, key order shuffled — must produce
    // the identical hash so the variant cache doesn't fragment across
    // engine versions.
    const nodeA = {
      expr: {
        op: 'matchExpr',
        type: { kind: 'vec', n: 4, elem: 'f32' },
        scrutinee: { op: 'param', type: { kind: 'scalar', scalar: 'u32' }, name: 'class_id' },
        cases: [[0, { op: 'lit', type: { kind: 'vec', n: 4, elem: 'f32' }, value: 0 }]],
        default: { op: 'lit', type: { kind: 'vec', n: 4, elem: 'f32' }, value: -1 },
      },
    }
    const nodeB = {
      expr: {
        default: { value: -1, type: { elem: 'f32', n: 4, kind: 'vec' }, op: 'lit' },
        cases: [[0, { value: 0, type: { elem: 'f32', n: 4, kind: 'vec' }, op: 'lit' }]],
        scrutinee: { name: 'class_id', type: { scalar: 'u32', kind: 'scalar' }, op: 'param' },
        type: { elem: 'f32', n: 4, kind: 'vec' },
        op: 'matchExpr',
      },
    }
    expect(matchArmsKey(nodeA, undefined)).toBe(matchArmsKey(nodeB, undefined))
  })

  it('Node + string mixed inputs combine cleanly', () => {
    const node = { expr: { op: 'lit', value: 1 } }
    const stroke = 'if (y == 0u) { s = B; }'
    expect(matchArmsKey(node, stroke)).toMatch(/^\|m:[a-z0-9]+$/)
  })

  it('semantically different Nodes hash differently', () => {
    const nodeA = { expr: { op: 'lit', value: 1 } }
    const nodeB = { expr: { op: 'lit', value: 2 } }
    expect(matchArmsKey(nodeA, undefined)).not.toBe(matchArmsKey(nodeB, undefined))
  })
})
