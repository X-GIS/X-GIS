import { describe, it, expect } from 'vitest'
import { fn, module, f64T, f32T, vec2fT, vec3fT, vec4fT, toF32 } from '../../ir/index.js'
import type { Expr, ModuleDecl, FuncDecl, Stmt, ShaderType } from '../../ir/index.js'
import { memberFold } from './member-fold.js'
import { fixpoint, mapModuleExprs } from './index.js'
import { fp64Lower } from '../fp64-lower.js'
import { forceInline } from '../force-inline.js'

// ── raw-IR scaffolding: these shapes are what the emitter's CSE chain produces, and
//    the builder has no spelling for "a member of a let-bound construct" on its own.

const lit = (v: number): Expr => ({ op: 'lit', type: f32T, value: v })
const ref = (name: string, type: ShaderType = f32T): Expr => ({ op: 'varref', type, name })
const ctor = (type: ShaderType, args: Expr[]): Expr => ({ op: 'construct', type, args })
const mem = (base: Expr, field: string, type: ShaderType = f32T): Expr => ({
  op: 'member',
  type,
  base,
  field,
})
const letS = (name: string, expr: Expr): Stmt => ({ s: 'let', name, expr })

/** A one-fn module whose body is `stmts`, run through memberFold; returns the body. */
const foldBody = (stmts: Stmt[], structs: ModuleDecl['structs'] = []): readonly Stmt[] => {
  const f: FuncDecl = { name: 'k', params: [], ret: f32T, body: stmts }
  return memberFold({ funcs: [f], structs, bindings: [], consts: [] } as ModuleDecl).funcs[0]!.body
}
const retExprOf = (body: readonly Stmt[]): Expr => {
  const last = body[body.length - 1]!
  if (last.s !== 'return' || last.expr === undefined) throw new Error('no return')
  return last.expr
}
const ret = (e: Expr): Stmt => ({ s: 'return', expr: e })

describe('memberFold — reads a component back out of the construct that built it', () => {
  it('resolves THROUGH the let binding — the shape the CSE chain actually emits', () => {
    const body = foldBody([
      letS('_cse3', ctor(vec2fT, [ref('hi'), ref('lo')])),
      ret(mem(ref('_cse3', vec2fT), 'y')),
    ])
    expect(retExprOf(body)).toEqual(ref('lo'))
  })

  it('resolves a syntactic construct.member too', () => {
    const body = foldBody([ret(mem(ctor(vec2fT, [ref('hi'), ref('lo')]), 'x'))])
    expect(retExprOf(body)).toEqual(ref('hi'))
  })

  it('accepts the rgba spelling of the same component', () => {
    const body = foldBody([
      letS('_c', ctor(vec4fT, [ref('r'), ref('g'), ref('b'), ref('a')])),
      ret(mem(ref('_c', vec4fT), 'b')),
    ])
    expect(retExprOf(body)).toEqual(ref('b'))
  })

  it('resolves the splat — vecN(x).<any> is x', () => {
    const body = foldBody([letS('_p', ctor(vec3fT, [ref('s')])), ret(mem(ref('_p', vec3fT), 'z'))])
    expect(retExprOf(body)).toEqual(ref('s'))
  })

  it('resolves a struct field by NAME, through the declaration', () => {
    const t = { kind: 'struct', name: 'DF64Vec2' } as const
    const body = foldBody(
      [
        letS('_v', ctor(t, [ref('planeHi', vec2fT), ref('planeLo', vec2fT)])),
        ret(mem(ref('_v', t), 'lo', vec2fT)),
      ],
      [
        {
          name: 'DF64Vec2',
          fields: [
            { name: 'hi', type: vec2fT },
            { name: 'lo', type: vec2fT },
          ],
        },
      ],
    )
    expect(retExprOf(body)).toEqual(ref('planeLo', vec2fT))
  })
})

describe('memberFold — bails rather than guessing', () => {
  it('leaves MIXED-WIDTH composition alone: vec4(v2, x, y) has no arg-is-component map', () => {
    const src = mem(ref('_m', vec4fT), 'x')
    const body = foldBody([
      letS('_m', ctor(vec4fT, [ref('v2', vec2fT), ref('x'), ref('y')])),
      ret(src),
    ])
    expect(retExprOf(body)).toEqual(src)
  })

  it('leaves the vecN(vecN) copy ctor alone — the one arg is not a scalar', () => {
    const src = mem(ref('_c', vec2fT), 'x')
    const body = foldBody([letS('_c', ctor(vec2fT, [ref('other', vec2fT)])), ret(src)])
    expect(retExprOf(body)).toEqual(src)
  })

  it('leaves MULTI-COMPONENT swizzles alone', () => {
    const src = mem(ref('_c', vec3fT), 'xy', vec2fT)
    const body = foldBody([letS('_c', ctor(vec3fT, [ref('a'), ref('b'), ref('c')])), ret(src)])
    expect(retExprOf(body)).toEqual(src)
  })

  it('leaves a MUTATED name alone — its construct is not the value being read', () => {
    const src = mem(ref('_c', vec2fT), 'x')
    const body = foldBody([
      letS('_c', ctor(vec2fT, [ref('hi'), ref('lo')])),
      { s: 'assign', target: ref('_c', vec2fT), expr: ctor(vec2fT, [lit(1), lit(2)]) },
      ret(src),
    ])
    expect(retExprOf(body)).toEqual(src)
  })

  it('skips a fn containing a raw Stmt', () => {
    const src = mem(ref('_c', vec2fT), 'x')
    const body = foldBody([
      letS('_c', ctor(vec2fT, [ref('hi'), ref('lo')])),
      { s: 'raw', wgsl: '// touches _c invisibly' },
      ret(src),
    ])
    expect(retExprOf(body)).toEqual(src)
  })

  it('leaves a struct whose ctor arity disagrees with its declaration', () => {
    const t = { kind: 'struct', name: 'Partial' } as const
    const src = mem(ref('_v', t), 'b')
    const body = foldBody(
      [letS('_v', ctor(t, [ref('a')])), ret(src)],
      [
        {
          name: 'Partial',
          fields: [
            { name: 'a', type: f32T },
            { name: 'b', type: f32T },
          ],
        },
      ],
    )
    expect(retExprOf(body)).toEqual(src)
  })
})

// ═══ The reason the fold could not ship before: it deletes `renormForCancel` ═══
//
// `renormForCancel` feeds a raw df64 operand through `df64_add(x, 0)` before a cancelling
// op, so the twoSum recomputes the pair and a LOADED lo becomes a COMPUTED one — the
// launder #915 paid for on Apple `sub` and Blackwell WebGL2 `div`. Once forceInline copies
// the addend into the body, this fold is exactly what can resolve `_cseN.x` back to the
// literal `0.0`; const-prop then carries it into `s = a + b` and the pre-existing
// `x + 0 -> x` identity deletes the add.
//
// So fp64-lower now spells that zero through the optBarrier bitcast round-trip, and these
// two arms are the CUT (§12): the SAME module, differing in that one thing, run through the
// SAME pipeline. Without the barrier the arithmetic drops; with it, it cannot.
//
// TWO rules currently stop it, and the difference between them matters. The barrier makes
// the zero unresolvable by ANY fold — that is the by-construction guarantee, and it is what
// #1969's header asked for. This pass's own call exclusion ALSO happens to cover it, because
// a bitcast is a call. That second one is a property of this pass and could be relaxed
// tomorrow; the first cannot. The cut below still isolates the barrier either way: stripping
// it leaves literal arguments, which no exclusion here touches.
describe('memberFold — the barriered renorm zero survives it, and a bare literal does not', () => {
  // An f64 divide on two PARAMS: neither operand is a helper output, so fp64Lower inserts
  // renormForCancel before the cancelling op.
  const guarded = module({
    funcs: [fn('g', { a: f64T, b: f64T }, f32T, (p, bb) => bb.ret(toF32(p.a.div(p.b))))],
  })

  /** Undo the barrier: `bitcastF32(bitcastU32(<lit>))` back to the literal. Reconstructing
   *  the pre-barrier shape FROM the shipped module (rather than hand-writing it) is what
   *  makes the two arms differ in exactly one thing. */
  const unbarrier = (e: Expr): Expr => {
    if (e.op !== 'call' || e.fn !== 'bitcastF32' || e.args.length !== 1) return e
    const inner = e.args[0]!
    if (inner.op !== 'call' || inner.fn !== 'bitcastU32' || inner.args.length !== 1) return e
    const v = inner.args[0]!
    return v.op === 'lit' ? v : e
  }

  const arithOps = (m: ModuleDecl): number => {
    let ops = 0
    const walk = (e: unknown): void => {
      if (!e || typeof e !== 'object') return
      if ((e as { op?: string }).op === 'binop' || (e as { op?: string }).op === 'unop') ops++
      for (const v of Object.values(e as Record<string, unknown>)) {
        if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') walk(v)
      }
    }
    for (const f of m.funcs) f.body.forEach(walk)
    return ops
  }

  const flatten = (m: ModuleDecl): ModuleDecl => fixpoint(forceInline(fixpoint(m), 'all'))

  const lowered = fp64Lower(guarded)
  const WITH = flatten(lowered)
  const WITHOUT = flatten(mapModuleExprs(lowered, unbarrier))

  // ── the CAUSE, asserted before the effect (§12: order decides which half a red run
  //    accuses). If the barrier is not in the shipped lowering, everything below is vacuous.
  it('fp64Lower spells the renorm zero through the barrier, and it survives flattening', () => {
    const bitcasts = (m: ModuleDecl): number => {
      let n = 0
      const walk = (e: unknown): void => {
        if (!e || typeof e !== 'object') return
        if ((e as { fn?: string }).fn === 'bitcastF32') n++
        for (const v of Object.values(e as Record<string, unknown>)) {
          if (Array.isArray(v)) v.forEach(walk)
          else if (v && typeof v === 'object') walk(v)
        }
      }
      for (const f of m.funcs) f.body.forEach(walk)
      return n
    }
    expect(bitcasts(lowered), 'fp64Lower emitted no barriered renorm zero').toBeGreaterThan(0)
    expect(
      bitcasts(WITH),
      'the barrier did not survive forceInline + the fixpoint',
    ).toBeGreaterThan(0)
    expect(bitcasts(WITHOUT), 'the cut did not actually remove the barrier').toBe(0)
  })

  // ── the EFFECT. Same module, same pipeline, one difference.
  it('the fold deletes arithmetic ONLY when the zero is a bare literal', () => {
    expect(
      arithOps(WITHOUT),
      "member-fold no longer reaches the renorm's twoSum — if the fold or the identity rules " +
        'changed, re-derive whether the barrier is still load-bearing before relaxing it',
    ).toBeLessThan(arithOps(WITH))
  })
})
