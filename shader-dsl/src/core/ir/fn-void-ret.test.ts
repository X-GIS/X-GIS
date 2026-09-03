import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  If,
  Return,
  f32,
  vec2,
  f32T,
  vec2fT,
  voidT,
  type FnHandle,
  type Node,
  type ReadonlyNode,
} from './index.js'
import { emitModule } from '../backends/wgsl.js'

// ═══ #2458 — a body that returns nothing at the TS level must NAME its return type ═══
//
// `inferReturnType` walks the recorded statements at RUNTIME and finds the type a
// guard-style body returns through an ambient `Return()`. TypeScript cannot: the value never
// passes through a `return`, so `R` fell back to its constraint and the handle was
// `FnHandle<P, string>` — every call site of such a fn outside the phantom-key checker.
//
// Inferring `'void'` instead would be WORSE, not a fix: it is wrong for exactly the
// guard-style case, and a key that LIES is worse than `string`. So the ret-inferring
// overloads no longer accept a void body, and the author writes the type (or `voidT`).

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// Instrument check — `Exact` must SEPARATE the fallback from a precise key, or every
// assertion below is vacuous.
const _exactRejectsFallback: Exact<string, 'void'> = false

describe('#2458 — fn() and the void body', () => {
  it('REJECTS a void body on the ret-inferring overload', () => {
    // @ts-expect-error — #2458: the body returns nothing, so tsc cannot know the return key.
    // Before this change the overload matched and produced FnHandle<P, string>.
    fn('guard_no_ret', { x: f32T }, ({ x }) => {
      If(x.gt(0), () => {
        Return(x)
      })
      Return(f32(0))
    })
    // The same body with a ret is accepted and RUNS — so the directive above is rejecting the
    // missing token, not a call that was impossible to make.
    const ok = fn('guard_ret', { x: f32T }, f32T, ({ x }) => {
      If(x.gt(0), () => {
        Return(x)
      })
      Return(f32(0))
    })
    expect(emitModule(module({ funcs: [ok] }))).toContain('fn guard_ret(x: f32) -> f32')
  })

  it('gives a guard-style body its declared key instead of `string`', () => {
    const g = fn('guard_vec', { x: f32T }, vec2fT, ({ x }) => {
      If(x.gt(0), () => {
        Return(vec2(x, x))
      })
      Return(vec2(f32(0), f32(0)))
    })
    // The load-bearing assertion: `'vec2<f32>'` EXACTLY, not `string`. On main this handle
    // was FnHandle<P, string> and every call site of it needed a cast.
    const _g: Exact<typeof g, FnHandle<{ x: typeof f32T }, 'vec2<f32>'>> = true
    expect(_g).toBe(true)
    expect(emitModule(module({ funcs: [g] }))).toContain('fn guard_vec(x: f32) -> vec2<f32>')
  })

  it('lands a genuinely void fn on `void`, which KeyOf now spells (#2456)', () => {
    const k = fn('cs_entry', {}, voidT, () => {}, { stage: 'compute' })
    // Asserted on the CALL RESULT's key, not on the whole handle: an empty param spec infers
    // as `{}` rather than `Record<string, never>`, so a whole-handle Exact would fail on the
    // param half and say nothing about the return key this test is for.
    const _k: Exact<ReturnType<typeof k>, Node<'void'>> = true
    expect([_k]).not.toContain(false)
    expect(_exactRejectsFallback).toBe(false)
    expect(emitModule(module({ funcs: [k] }))).toContain('fn cs_entry()')
  })

  it('the token moves NO emitted byte — it names what inferReturnType already computed', () => {
    // The claim this PR's 29 call sites rest on. The shape is the one every migrated site has:
    // a bare `Return()` early-out guard (no value, so inferReturnType's scan skips it — it
    // requires `s.expr`) and a statement, never a value, last.
    const body = (b: { x: ReadonlyNode<'f32'> }) => {
      If(b.x.gt(0), () => {
        Return()
      })
      Return()
    }
    const withToken = fn('void_kernel', { x: f32T }, voidT, body, { stage: 'compute' })
    // @ts-expect-error — #2458: the inferring overload no longer accepts a void body. This arm
    // exists ONLY to emit what the pre-change call site emitted, so the two can be compared.
    const inferred = fn('void_kernel', { x: f32T }, body, { stage: 'compute' })
    expect(emitModule(module({ funcs: [withToken] }))).toBe(
      emitModule(module({ funcs: [inferred] })),
    )
  })
})
