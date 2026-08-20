import { describe, expect, it } from 'vitest'
import {
  module,
  fn,
  f32,
  f32T,
  i32,
  u32,
  u32T,
  vec3,
  arrayLit,
  normalize,
  Var,
  type ModuleDecl,
  type Stmt,
} from '../../ir/index.js'
import { emitModule } from '../../backends/wgsl.js'
import { compileModule } from '../../oracle.js'
import { structDecl, storageBuffer } from '../../sot.js'
import { gvn } from './gvn.js'

// gvn numbers a compound, local-touching subexpr that repeats ACROSS statements in a
// straight-line block — the redundancy cse (input-only) and cse-local (within one
// statement) both miss. Conservative: aborts if a referenced root is reassigned in
// the span. Bit-exact -> pinned by oracle value-equality.

/** Count `_gvN` temps gvn introduced (its observable effect — robust to the FnHandle
 *  wrapper, unlike whole-module JSON equality). */
function gvTempCount(m: ModuleDecl): number {
  let n = 0
  const walk = (body: readonly Stmt[]): void => {
    for (const s of body) {
      if ((s.s === 'let' || s.s === 'var') && /^_gv\d+$/.test(s.name)) n++
      if (s.s === 'if') {
        for (const a of s.arms) walk(a.body)
        if (s.elseBody) walk(s.elseBody)
      } else if (s.s === 'for') walk(s.body)
      else if (s.s === 'switch') {
        for (const c of s.cases) walk(c.body)
        if (s.defaultBody) walk(s.defaultBody)
      }
    }
  }
  for (const f of m.funcs) walk(f.body)
  return n
}

const oracleStable = (m: ModuleDecl, name: string, xs: number[]): void => {
  const before = compileModule(m).fns[name]!
  const after = compileModule(gvn(m)).fns[name]!
  for (const x of xs) expect(after(x), `x=${x}`).toEqual(before(x))
}

describe('gvn — cross-statement value numbering', () => {
  it('hoists a local-touching repeat that spans two statements to one temp', () => {
    // normalize(v) (touches the local v) appears in two separate `let`s. cse skips it
    // (not input-only), cse-local skips it (not within one statement) -> gvn collapses it.
    const m = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.let('v', vec3(x, x.mul(2), x.mul(3)))
          const p = b.let('p', normalize(v).x)
          const q = b.let('q', normalize(v).y)
          b.ret(p.add(q))
        }),
      ],
    })
    const out = gvn(m)
    expect(gvTempCount(out)).toBeGreaterThanOrEqual(1)
    const body = emitModule(out)
    const fbody = body.slice(body.indexOf('fn f('))
    const calls = (fbody.match(/normalize\(/g) ?? []).length
    expect(calls, `normalize should emit once after gvn, got ${calls}:\n${fbody}`).toBe(1)
    oracleStable(m, 'f', [1, 2, 3.5, -4, 0.25])
  })

  it('does NOT number across a reassignment of a referenced root', () => {
    // v is mutated BETWEEN the two normalize(v) uses, so the two values differ — the
    // span reassignment check must abort.
    const m = module({
      funcs: [
        fn('g', { x: f32T }, f32T, ({ x }, b) => {
          const v = Var(vec3(x, x, x))
          const p = b.let('p', normalize(v).x)
          v.assign(v.add(vec3(1, 1, 1))) // mutate v in the span
          const q = b.let('q', normalize(v).y)
          b.ret(p.add(q))
        }),
      ],
    })
    expect(gvTempCount(gvn(m))).toBe(0) // nothing hoisted
    oracleStable(m, 'g', [1, 2, 3.5, -4, 0.25])
  })

  it('leaves input-only repeats alone (that is cse’s job, not gvn’s)', () => {
    // x*x is input-only (x is a param) — gvn targets only local-touching repeats.
    const m = module({
      funcs: [
        fn('h', { x: f32T }, f32T, ({ x }, b) => {
          const p = b.let('p', x.mul(x).add(1))
          const q = b.let('q', x.mul(x).mul(2))
          b.ret(p.add(q))
        }),
      ],
    })
    expect(gvTempCount(gvn(m))).toBe(0)
  })

  it('does NOT lift a repeat that only occurs under a short-circuit (||) RHS', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.let('v', vec3(x, x, x))
          // normalize(v) appears only inside the guarded RHS of two ORs (different stmts).
          const p = b.let('p', x.gt(0).or(normalize(v).x.gt(0.5)).select(f32(1), f32(0)))
          const q = b.let('q', x.gt(0).or(normalize(v).y.gt(0.5)).select(f32(2), f32(0)))
          b.ret(p.add(q))
        }),
      ],
    })
    expect(gvTempCount(gvn(m))).toBe(0) // guarded -> excluded
    oracleStable(m, 'k', [1, -2, 0.5])
  })

  it('bails out on a fn containing a raw Stmt', () => {
    const base = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(2))
        }),
      ],
    })
    const withRaw: ModuleDecl = {
      ...base,
      funcs: [{ ...base.funcs[0]!, body: [{ s: 'raw', wgsl: 'return x * 2.0;' }] }],
    }
    expect(gvTempCount(gvn(withRaw))).toBe(0) // untouched
  })
})

// ═══ Control-flow CONDITIONS (#1886) ═══
//
// `valueExprs` used to return [] for every control-flow statement, so an `if`
// condition was never tallied and never rewritten — "handled by recursion" was true
// of the BODIES and false of the CONDITIONS.
//
// Measured effect on the 87-source baked corpus, before vs after a real build + bake:
// raw call sites 12239 -> 12233, i.e. SIX. This pass earns its place as the
// prerequisite for cross-block dominance, not on that number.
//
// Only the FIRST arm's condition is unconditionally evaluated, which is what makes
// binding it to a `let` before the statement free. The two exclusions below are not
// hypothetical caution — they are the cases that would make this unsound, and each
// has its own arm here.
describe('gvn — control-flow conditions (#1886)', () => {
  it('numbers a repeat shared between an `if` condition and a later statement', () => {
    // normalize(v) is evaluated by the `if` condition on every path, then again by
    // `q` in the same block. Before #1886 gvn saw only ONE occurrence (the `q` one)
    // and did nothing.
    const m = module({
      funcs: [
        fn('c', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.let('v', vec3(x, x, x))
          const r = Var(f32(0))
          b.if(normalize(v).x.gt(0.5), () => {
            r.assign(f32(1))
          })
          const q = b.let('q', normalize(v).y)
          b.ret(r.add(q))
        }),
      ],
    })
    const out = gvn(m)
    expect(gvTempCount(out)).toBeGreaterThanOrEqual(1)
    const wgsl = emitModule(out)
    const fbody = wgsl.slice(wgsl.indexOf('fn c('))
    const calls = (fbody.match(/normalize\(/g) ?? []).length
    expect(calls, `normalize should emit once after gvn, got ${calls}:\n${fbody}`).toBe(1)
    oracleStable(m, 'c', [1, 2, -3, 0.25])
  })

  it('does NOT number from an `else if` condition — the arm before it guards it', () => {
    // Hoisting normalize(v) to before the `if` would evaluate it on the x > 0 path,
    // where the authored code never does. Same rule that already excludes a `&&`/`||`
    // RHS and a `select` branch.
    const m = module({
      funcs: [
        fn('e', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.let('v', vec3(x, x, x))
          const r = Var(f32(0))
          b.if(x.gt(0), () => {
            r.assign(f32(1))
          }).elif(normalize(v).x.gt(0.5), () => {
            r.assign(f32(2))
          })
          const q = b.let('q', normalize(v).y)
          b.ret(r.add(q))
        }),
      ],
    })
    expect(gvTempCount(gvn(m))).toBe(0)
    oracleStable(m, 'e', [1, -2, 0.5])
  })

  it('does NOT number from a `for` condition — it is re-evaluated per iteration', () => {
    // A loop condition runs once per iteration; lifting one out is loop-invariance,
    // which is licm's job and needs an invariance proof gvn does not have.
    //
    // The repeat sits on the LEFT of the `&&`, deliberately. On the RIGHT it would be
    // excluded by the short-circuit guard whatever `valueExprs` returns, and this arm
    // would then pass with `for` conditions tallied — i.e. prove nothing. It is the
    // left operand that `tally` treats as unconditional, so the only thing keeping
    // this green is `for` being absent from `valueExprs`. (`normalize(vec3(x,x,x)).x`
    // is ±0.577, so the left operand is always true and `i < 2` still terminates.)
    const m = module({
      funcs: [
        fn('l', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.let('v', vec3(x, x, x))
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) =>
              normalize(v)
                .x.gt(-2)
                .and(i.lt(i32(2))),
            (cb) => {
              cb.addAssign(acc, f32(1))
            },
          )
          const q = b.let('q', normalize(v).y)
          b.ret(acc.add(q))
        }),
      ],
    })
    expect(gvTempCount(gvn(m))).toBe(0)
    oracleStable(m, 'l', [1, -2, 0.5])
  })
})

// ═══ Cross-block reuse: an inner block may read an enclosing block's temp (#1886) ═══
//
// gvn numbered each block in isolation, so a value the OUTER block had already bound
// to a temp was recomputed from scratch inside a nested block. That costs nothing to
// remove — the outer binding is evaluated on every path that reaches the inner block,
// so replacing the inner recompute with the temp adds no work anywhere.
//
// Measured on the 87-source baked corpus: 144 of the 241 remaining repeats are this
// shape, and 84 of those need nothing but the env being passed down (the outer block
// already mints a temp). No group in the corpus has an occurrence inside a loop body,
// so the back-edge guard below is free here — it is in the code for correctness, not
// for a measured case.
describe('gvn — cross-block reuse (#1886)', () => {
  it('reuses an enclosing block’s temp inside a nested `if` body', () => {
    const m = module({
      funcs: [
        fn('d', { x: f32T }, f32T, ({ x }, b) => {
          const v = b.let('v', vec3(x, x, x))
          const p = b.let('p', normalize(v).x) // outer occurrence 1
          const q = b.let('q', normalize(v).y) // outer occurrence 2 -> mints the temp
          const r = Var(f32(0))
          b.if(x.gt(0), () => {
            r.assign(normalize(v).z) // inner: must read the temp, not recompute
          })
          b.ret(p.add(q).add(r))
        }),
      ],
    })
    const out = gvn(m)
    const wgsl = emitModule(out)
    const fbody = wgsl.slice(wgsl.indexOf('fn d('))
    const calls = (fbody.match(/normalize\(/g) ?? []).length
    expect(calls, `normalize should emit once after gvn, got ${calls}:\n${fbody}`).toBe(1)
    oracleStable(m, 'd', [1, 2, -3, 0.25])
  })

  it('does NOT reuse it past a statement that mutates a root the expr reads', () => {
    // The temp is bound from the pre-mutation `v`; inside the `if`, `normalize(v)` is a
    // DIFFERENT value. Reusing the temp there would be wrong, not merely wasteful — so
    // this arm is the one that fails if the invalidation filter is severed.
    const m = module({
      funcs: [
        fn('dm', { x: f32T }, f32T, ({ x }, b) => {
          const v = Var(vec3(x, x, x))
          const p = b.let('p', normalize(v).x)
          const q = b.let('q', normalize(v).y) // mints on the pre-mutation v
          v.assign(v.add(vec3(1, 1, 1))) // …then v changes
          const r = Var(f32(0))
          b.if(x.gt(0), () => {
            r.assign(normalize(v).z) // post-mutation value — must recompute
          })
          b.ret(p.add(q).add(r))
        }),
      ],
    })
    const out = gvn(m)
    const wgsl = emitModule(out)
    const fbody = wgsl.slice(wgsl.indexOf('fn dm('))
    const calls = (fbody.match(/normalize\(/g) ?? []).length
    expect(calls, `the post-mutation normalize must survive, got ${calls}:\n${fbody}`).toBe(2)
    oracleStable(m, 'dm', [1, 2, -3, 0.25])
  })

  it('does NOT reuse it inside a loop whose body mutates a root the expr reads', () => {
    // The back edge is what makes this different from the `if` above: iteration 2 sees
    // the mutated `v`, so a temp bound before the loop is stale from the second pass on.
    const m = module({
      funcs: [
        fn('dl', { x: f32T }, f32T, ({ x }, b) => {
          const v = Var(vec3(x, x, x))
          const p = b.let('p', normalize(v).x)
          const q = b.let('q', normalize(v).y) // mints before the loop
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(2)),
            (cb) => {
              cb.addAssign(acc, normalize(v).z) // stale after the mutation below
              v.assign(v.add(vec3(1, 1, 1)))
            },
          )
          b.ret(p.add(q).add(acc))
        }),
      ],
    })
    const out = gvn(m)
    const wgsl = emitModule(out)
    const fbody = wgsl.slice(wgsl.indexOf('fn dl('))
    const calls = (fbody.match(/normalize\(/g) ?? []).length
    expect(calls, `the in-loop normalize must survive, got ${calls}:\n${fbody}`).toBe(2)
    oracleStable(m, 'dl', [1, 2, -3, 0.25])
  })
})

// ═══ Indexing a BINDING is a memory load, not free navigation (#1886) ═══
//
// `isWorthHoisting` counts an expr as worth a temp only if it CALCULATES something
// (binop / call / construct / …). A bare `buf.at(i).field` calculates nothing, so no
// pass in the family will ever collapse it however often it repeats — which is right
// for a local struct and wrong for a storage/uniform buffer, where the index is a
// LOAD. 142 such repeats sit in X-GIS's own baked corpus, and unlike the peephole
// candidates this one is corpus-independent: any consumer feeding a shader through a
// storage buffer hits it, and a driver cannot reliably CSE a load through a dynamic
// index it must assume may alias.
describe('gvn — indexing a binding (#1886)', () => {
  const Slot = structDecl('GvnSlot', { id: u32T, size: f32T })

  it('collapses a repeated `buf.at(i).field` across two statements', () => {
    const buf = storageBuffer('gvn_buf', Slot, { group: 0, binding: 0, access: 'read' })
    const m = module({
      uses: [buf],
      funcs: [
        fn('bi', { x: f32T }, f32T, ({ x }, b) => {
          const i = b.let('i', u32(3))
          const p = b.let('p', buf.at(i).size.mul(x))
          const q = b.let('q', buf.at(i).size.add(1))
          b.ret(p.add(q))
        }),
      ],
    })
    const wgsl = emitModule(gvn(m))
    const fbody = wgsl.slice(wgsl.indexOf('fn bi('))
    const loads = (fbody.match(/gvn_buf\[/g) ?? []).length
    expect(loads, `the buffer should be indexed once, got ${loads}:\n${fbody}`).toBe(1)
  })

  it('does NOT collapse the same shape on a LOCAL array — only a binding is a load', () => {
    // The binding restriction is what does the work, and this is the arm that proves it:
    // the ONLY difference from the case above is that `arr` is not in the module's
    // binding set. Indexing a function-local array is addressing, not a load, so hoisting
    // it would trade one address chain for another and claim a memory win that is not
    // there. Both arms clear `refsLocal` and both index — `loadRoots` is the single
    // discriminator between them.
    const m = module({
      funcs: [
        fn('bl', { x: f32T }, f32T, ({ x }, b) => {
          const i = b.let('i', u32(1))
          const arr = b.let('arr', arrayLit(f32T, f32(1), f32(2), f32(3)))
          const p = b.let('p', arr.at(i, f32T).mul(x))
          const q = b.let('q', arr.at(i, f32T).add(1))
          b.ret(p.add(q))
        }),
      ],
    })
    expect(gvTempCount(gvn(m))).toBe(0)
  })

  it('does NOT collapse across a WRITE to the same read_write binding', () => {
    // The safety arm. Widening the predicate makes the load a CANDIDATE; every guard
    // downstream still has to refuse it when the value is not invariant. Nothing new
    // was written for this — `collectMutatedRoots` already walks an assign target
    // through its index/member chain, so a written `read_write` binding lands in the
    // mutated set and the span check rejects the pair. This arm is what fails if the
    // new path ever reaches the hoist without passing that check.
    const rw = storageBuffer('gvn_rw', f32T, { group: 0, binding: 1, access: 'read_write' })
    const m = module({
      uses: [rw],
      funcs: [
        fn('brw', { x: f32T }, f32T, ({ x }, b) => {
          const i = b.let('i', u32(1))
          const p = b.let('p', rw.at(i).mul(x))
          rw.at(i).assign(f32(7))
          const q = b.let('q', rw.at(i).add(1))
          b.ret(p.add(q))
        }),
      ],
    })
    expect(emitModule(gvn(m))).not.toMatch(/_gv\d+ = gvn_rw\[/)
  })
})
