// ═══════════════════════════════════════════════════════════════════
// nodeToWgslString — Expr → WGSL emit oracle round-trip
// ═══════════════════════════════════════════════════════════════════
//
// Pins the compiler-side `nodeToWgslString` against the runtime's
// `wgsl.ts:emitExpr` shape. Relocated out of `_back-compat/` in PR 2e.B.2
// with the adapter itself when its production splice-point retired; it
// survives as the emit-shape equality oracle used across the test suite.

import { describe, it, expect } from 'vitest'
import { nodeToWgslString } from './node-to-wgsl'

// Hand-built mini IR fixtures — match the `node-types.ts` local Expr shape
// verbatim so the test doesn't drag in the runtime workspace transitively.

const f32T = { kind: 'scalar' as const, scalar: 'f32' as const }
const u32T = { kind: 'scalar' as const, scalar: 'u32' as const }
const vec4fT = { kind: 'vec' as const, n: 4 as const, elem: 'f32' as const }

function f32Lit(v: number) {
  return { expr: { op: 'lit' as const, type: f32T, value: v } }
}

describe('nodeToWgslString — Expr → WGSL oracle', () => {
  it('round-trips a scalar arithmetic binop to parenthesised WGSL', () => {
    const node = {
      expr: {
        op: 'binop' as const, type: f32T, bop: '+' as const,
        a: { op: 'lit' as const, type: f32T, value: 1 },
        b: { op: 'lit' as const, type: f32T, value: 2 },
      },
    }
    expect(nodeToWgslString(node)).toBe('(1.0 + 2.0)')
  })

  it('emits a vec4f construct with all four components', () => {
    const node = {
      expr: {
        op: 'construct' as const, type: vec4fT,
        args: [f32Lit(1).expr, f32Lit(0).expr, f32Lit(0).expr, f32Lit(1).expr],
      },
    }
    expect(nodeToWgslString(node)).toBe('vec4<f32>(1.0, 0.0, 0.0, 1.0)')
  })

  it('emits a u32 literal with the `u` suffix', () => {
    const node = { expr: { op: 'lit' as const, type: u32T, value: 7 } }
    expect(nodeToWgslString(node)).toBe('7u')
  })

  it('emits select() with WGSL argument order (false, true, cond)', () => {
    const boolT = { kind: 'scalar' as const, scalar: 'bool' as const }
    const node = {
      expr: {
        op: 'select' as const, type: f32T,
        cond: { op: 'varref' as const, type: boolT, name: 'flag' },
        ifTrue: f32Lit(1).expr,
        ifFalse: f32Lit(0).expr,
      },
    }
    expect(nodeToWgslString(node)).toBe('select(0.0, 1.0, flag)')
  })

  it('emits a callFn-shaped call (fn name + arg list)', () => {
    const node = {
      expr: {
        op: 'call' as const, type: f32T, fn: 'clamp',
        args: [f32Lit(0.5).expr, f32Lit(0).expr, f32Lit(1).expr],
      },
    }
    expect(nodeToWgslString(node)).toBe('clamp(0.5, 0.0, 1.0)')
  })

  it('throws if a matchExpr leaks into the adapter (fn-body-only path)', () => {
    const leak = {
      expr: {
        op: 'matchExpr' as const, type: f32T,
        scrutinee: { op: 'lit' as const, type: u32T, value: 0 },
        cases: [[0, f32Lit(1).expr] as const],
        default: f32Lit(-1).expr,
      },
    }
    expect(() => nodeToWgslString(leak)).toThrow(/matchExpr is fn-body-only/)
  })
})
