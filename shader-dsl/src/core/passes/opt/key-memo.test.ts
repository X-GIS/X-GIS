import { describe, it, expect } from 'vitest'
import { keyOf } from './expr-utils.js'
import { f32T, vec2fT } from '../../ir/index.js'
import type { Expr } from '../../ir/index.js'

// ═══ #2465 — keyOf is memoised on the Expr OBJECT; these pin what that must not break ═══
//
// The memo exists because keyOf is called per EXPRESSION NODE by four passes and re-run every
// fixpoint iteration: 254,232 calls in one `line` emit, against 776 collectLocals and 8,256
// collectMutatedRoots calls in the SAME emit. (That measurement is also what refuted the
// premise this work started from — see #2465.)
//
// The memo can break in exactly one way that no existing test would catch, and it is the way
// an "optimisation" would naturally introduce: making the key IDENTITY-based. Every CSE
// family pass depends on two STRUCTURALLY EQUAL but DISTINCT objects sharing a key — that is
// the whole mechanism. A memo that returned a per-object unique key would still be internally
// consistent, still pass every "same object, same key" check, and silently disable CSE, GVN
// and LICM at once while every emit stayed valid.

const lit = (v: number): Expr => ({ op: 'lit', type: f32T, value: v })
const add = (a: Expr, b: Expr): Expr => ({ op: 'binop', type: f32T, bop: '+', a, b })

describe('#2465 — the keyOf memo', () => {
  it('gives two DISTINCT but structurally equal exprs the SAME key', () => {
    // Built separately on purpose: no shared sub-object, so nothing but structure can match
    // them. This is the arm that dies if the memo is ever made identity-based.
    const a = add(lit(1), lit(2))
    const b = add(lit(1), lit(2))
    expect(a).not.toBe(b)
    expect(a.op === 'binop' && b.op === 'binop' && a.a).not.toBe(b.op === 'binop' ? b.a : null)
    expect(keyOf(a)).toBe(keyOf(b))
  })

  it('still SEPARATES exprs that differ, including deep inside', () => {
    expect(keyOf(add(lit(1), lit(2)))).not.toBe(keyOf(add(lit(1), lit(3))))
    // A difference two levels down, past the point a shallow key would look.
    const deep = (leaf: number): Expr => add(add(lit(0), add(lit(1), lit(leaf))), lit(9))
    expect(keyOf(deep(2))).not.toBe(keyOf(deep(3)))
  })

  it('returns a STABLE key for the same object across calls', () => {
    const e = add(lit(1), lit(2))
    const first = keyOf(e)
    for (let i = 0; i < 3; i++) expect(keyOf(e)).toBe(first)
  })

  it('keys by TYPE as well as value — the #2408 arm the memo must not erase', () => {
    // u32(-1.0) is 0 (saturates); u32(-1) is 4294967295 (bit reinterpretation). Sharing a key
    // merged them, which moved emitted WGSL and GLSL. Re-asserted here because a memo keyed on
    // anything less than the full structural key would re-open it.
    const asF32: Expr = { op: 'lit', type: f32T, value: -1 }
    const asVec: Expr = { op: 'lit', type: vec2fT, value: -1 }
    expect(keyOf(asF32)).not.toBe(keyOf(asVec))
  })
})
