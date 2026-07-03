import { describe, expect, it } from 'vitest'
import { module, fn, f32, f32T, vec3, normalize, Var, type ModuleDecl, type Stmt } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'
import { gvn } from './gvn'

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
