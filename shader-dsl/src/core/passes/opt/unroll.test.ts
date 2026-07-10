import { describe, it, expect } from 'vitest'
import {
  module,
  fn,
  f32,
  f32T,
  i32,
  i32T,
  u32,
  sin,
  toF32,
  type ModuleDecl,
  type Stmt,
} from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'
import { constProp } from './const-prop'
import { unrollLoops } from './unroll'

// unrollLoops flattens a SMALL, integer, compile-time fixed-count `for` into its N
// straight-line iterations — the induction var substituted with its per-iteration
// literal, each copy's locals alpha-renamed so nothing redeclares. Conservative:
// skips non-constant bounds, counter reassignment, loop-level break/continue, and
// over-budget loops. Bit-exact for integer counters -> pinned by oracle value-equality.

/** Count `for` statements remaining anywhere in the module (0 == fully unrolled). */
function countFors(m: ModuleDecl): number {
  let n = 0
  const walk = (body: readonly Stmt[]): void => {
    for (const s of body) {
      if (s.s === 'for') {
        n++
        walk([s.init])
        walk(s.body)
      } else if (s.s === 'if') {
        for (const a of s.arms) walk(a.body)
        if (s.elseBody) walk(s.elseBody)
      } else if (s.s === 'switch') {
        for (const c of s.cases) walk(c.body)
        if (s.defaultBody) walk(s.defaultBody)
      }
    }
  }
  for (const f of m.funcs) walk(f.body)
  return n
}

/** Every `let` / `var` binding name declared anywhere in the module. */
function declNames(m: ModuleDecl): string[] {
  const out: string[] = []
  const walk = (body: readonly Stmt[]): void => {
    for (const s of body) {
      if (s.s === 'let' || s.s === 'var') out.push(s.name)
      if (s.s === 'if') {
        for (const a of s.arms) walk(a.body)
        if (s.elseBody) walk(s.elseBody)
      } else if (s.s === 'for') {
        walk([s.init])
        walk(s.body)
      } else if (s.s === 'switch') {
        for (const c of s.cases) walk(c.body)
        if (s.defaultBody) walk(s.defaultBody)
      }
    }
  }
  for (const f of m.funcs) walk(f.body)
  return out
}

/** Oracle value-equality across argument sets — the correctness invariant every
 *  optimizer pass must preserve (unroll must produce identical results). */
const oracleStable = (m: ModuleDecl, name: string, argsList: number[][]): void => {
  const before = compileModule(m).fns[name]!
  const after = compileModule(unrollLoops(m)).fns[name]!
  for (const args of argsList) expect(after(...args), `args=${args}`).toEqual(before(...args))
}

describe('unrollLoops — small fixed-count loop unrolling', () => {
  it('unrolls a fixed-count loop into N straight-line iterations', () => {
    // for i in 0..4 { acc += sin(x) } — 4 iterations, no counter use, no local.
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(4)),
            (cb) => {
              cb.addAssign(acc, sin(x))
            },
          )
          b.ret(acc)
        }),
      ],
    })
    const out = unrollLoops(m)
    expect(countFors(out)).toBe(0) // loop fully flattened
    // 4 straight-line copies of the accumulation (asserted on the IR, not on
    // emitModule's output — emit runs the full optimizer, whose CSE would collapse
    // the 4 identical input-only sin(x) copies back into one hoisted `let`).
    expect(out.funcs[0]!.body.filter((s) => s.s === 'assignOp').length).toBe(4)
    expect(() => emitModule(out)).not.toThrow() // the unrolled IR still emits cleanly
    oracleStable(m, 'k', [[0.5], [1], [-2], [0.25]])
  })

  it('substitutes the counter literal in a loop-variant body', () => {
    // for i in 0..4 { acc += x * toF32(i) } — body READS the counter.
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(4)),
            (cb, i) => {
              cb.addAssign(acc, x.mul(toF32(i)))
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(0)
    // If the per-iteration literal were wrong, these sums (x*(0+1+2+3)=6x) would diverge.
    oracleStable(m, 'k', [[0.5], [1], [-2]])
  })

  it('alpha-renames a body-declared local per iteration (no redeclaration)', () => {
    // for i in 0..3 { let t = x*toF32(i); acc += t*t } — each copy needs its OWN t.
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(3)),
            (cb, i) => {
              const t = cb.let('t', x.mul(toF32(i)))
              cb.addAssign(acc, t.mul(t))
            },
          )
          b.ret(acc)
        }),
      ],
    })
    const out = unrollLoops(m)
    expect(countFors(out)).toBe(0)
    const names = declNames(out)
    expect(names).not.toContain('t') // the original name is gone…
    const renamed = names.filter((n) => /^_u\d+_t$/.test(n))
    expect(renamed.length).toBe(3) // …replaced by one fresh name per iteration
    expect(new Set(renamed).size).toBe(3) // all distinct — no collision
    oracleStable(m, 'k', [[0.5], [1], [-2]])
  })

  it('unrolls nested fixed-count loops (inner first)', () => {
    // for i in 0..2 { for j in 0..2 { acc += toF32(i + j) } } — 4 total iterations.
    const m = module({
      funcs: [
        fn('k', {}, f32T, (_p, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(2)),
            (cb, i) => {
              cb.forRange(
                'j',
                i32(0),
                (j) => j.lt(i32(2)),
                (cb2, j) => {
                  cb2.addAssign(acc, toF32(i.add(j)))
                },
              )
            },
          )
          b.ret(acc)
        }),
      ],
    })
    const out = unrollLoops(m)
    expect(countFors(out)).toBe(0) // BOTH loops flattened
    oracleStable(m, 'k', [[]]) // (0+0)+(0+1)+(1+0)+(1+1) = 4
  })

  it('skips a non-constant (runtime) bound', () => {
    // for i in 0..n { acc += x } — n is a runtime param, not a constant.
    const m = module({
      funcs: [
        fn('f', { n: i32T, x: f32T }, f32T, ({ n, x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(n),
            (cb) => {
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(1) // loop preserved
    oracleStable(m, 'f', [
      [3, 0.5],
      [0, 1],
      [5, -2],
    ])
  })

  it('skips a counter reassigned inside the body', () => {
    // for i in 0..4 { i = i + 1; acc += x } — the trip count is no longer the header's.
    const m = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(4)),
            (cb, i) => {
              i.assign(i.add(i32(1)))
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(1) // preserved — literal substitution would be wrong
    oracleStable(m, 'f', [[0.5], [1]])
  })

  it('skips a body carrying a loop-level break', () => {
    // for i in 0..4 { if (i > 2) { break } acc += x } — no loop remains to break.
    const m = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(4)),
            (cb, i) => {
              cb.if(i.gt(i32(2)), (c2) => {
                c2.break()
              })
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(1) // preserved
    oracleStable(m, 'f', [[0.5], [1]])
  })

  it('skips a fn containing a raw Stmt (opaque)', () => {
    const base = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(4)),
            (cb) => {
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    // A raw WGSL fragment may reference the counter textually — bail the whole fn.
    const withRaw: ModuleDecl = {
      ...base,
      funcs: [
        {
          ...base.funcs[0]!,
          body: [...base.funcs[0]!.body, { s: 'raw', wgsl: '// noop' } as Stmt],
        },
      ],
    }
    expect(countFors(unrollLoops(withRaw))).toBe(1) // loop preserved
  })

  it('respects the growth budget (small unrolls, large stays a loop)', () => {
    // 8 iterations of a tiny body (trip <= cap, 8 x tiny cost under the node budget) → unrolls.
    const tiny8 = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(8)),
            (cb) => {
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(tiny8))).toBe(0)

    // 8 iterations of a fat body: trip is under the cap, but 8 x node-cost blows the
    // budget → left as a loop (the "don't bloat" guard).
    const fat8 = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(8)),
            (cb) => {
              cb.addAssign(acc, x.mul(x).mul(x).mul(x).mul(x).mul(x).mul(x))
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(fat8))).toBe(1)

    // A trip count above the small-loop cap → left as a loop even with a tiny body.
    const trip64 = module({
      funcs: [
        fn('g', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(64)),
            (cb) => {
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(trip64))).toBe(1)
  })

  it('re-runs without re-minting a colliding fresh name (after an enabling pass)', () => {
    // The pass is built to run on the optimize()->emit fixpoint, where a pass like
    // constProp exposes a loop skipped on the first run. Loop A unrolls immediately;
    // loop B's bound is a const-`let`, so it is deferred until constProp inlines the
    // literal, then unrolls on the SECOND pass. BOTH bodies declare a local `t`:
    // unless the fresh-name suffix is seeded past the first pass's `_u0_t`, the second
    // pass re-mints `_u0_t` — two `let _u0_t` in one WGSL scope (a naga / tint
    // redeclaration), which oracle value-equality cannot detect.
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(2)),
            (cb, i) => {
              const t = cb.let('t', x.mul(toF32(i)))
              cb.addAssign(acc, t.mul(t))
            },
          )
          const bnd = b.let('bnd', i32(2)) // a const-let bound — constProp inlines it
          b.forRange(
            'j',
            i32(0),
            (j) => j.lt(bnd),
            (cb, j) => {
              const t = cb.let('t', x.mul(toF32(j)))
              cb.addAssign(acc, t.add(t))
            },
          )
          b.ret(acc)
        }),
      ],
    })
    const once = unrollLoops(m)
    expect(countFors(once)).toBe(1) // loop B deferred — its bound is not yet a literal
    const twice = unrollLoops(constProp(once))
    expect(countFors(twice)).toBe(0) // constProp exposed loop B → now unrolled
    const names = declNames(twice)
    expect(new Set(names).size).toBe(names.length) // every binding unique — no `_u0_t` twice
    // and the twice-unrolled module still computes the original values.
    const orig = compileModule(m).fns.k!
    const opt = compileModule(twice).fns.k!
    for (const args of [[0.5], [1], [-2]])
      expect(opt(...args), `args=${args}`).toEqual(orig(...args))
  })

  it('handles u32 counters — unrolls in range, skips a below-zero wrap', () => {
    // A normal u32 count unrolls exactly like i32.
    const up = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            u32(0),
            (i) => i.lt(u32(4)),
            (cb) => {
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(up))).toBe(0)
    oracleStable(up, 'f', [[0.5], [1], [-2]])

    // `for (i = 2u; i >= 0u; i -= 1)` never terminates on hardware — a u32 counter
    // wraps to 0xffffffff below zero. The unbounded JS sim would instead exit at −1
    // and unroll 3 finite copies; the range guard rejects it, leaving the (broken)
    // loop untouched rather than silently miscompiling it to finite code.
    const wrap = module({
      funcs: [
        fn('g', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            u32(2),
            (i) => i.ge(u32(0)),
            (cb) => {
              cb.addAssign(acc, x)
            },
            -1,
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(wrap))).toBe(1) // preserved — the trip count would diverge from hardware
  })

  it('unrolls a negative-step (count-down) loop', () => {
    // for (i = 3; i >= 0; i -= 1) — 4 iterations counting down. −1 is inside i32 range,
    // so the loop terminates cleanly and unrolls (unlike the u32 below-zero wrap above).
    const m = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(3),
            (i) => i.ge(i32(0)),
            (cb, i) => {
              cb.addAssign(acc, x.mul(toF32(i)))
            },
            -1,
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(0)
    // x*(3+2+1+0) = 6x — a wrong per-iteration literal would diverge.
    oracleStable(m, 'f', [[0.5], [1], [-2]])
  })

  it('unrolls a loop with a `!=` termination', () => {
    // for (i = 0; i != 4; i += 1) — the counter reaches the bound exactly.
    const m = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.ne(i32(4)),
            (cb) => {
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(0)
    oracleStable(m, 'f', [[0.5], [1], [-2]])
  })

  it('skips a body with an unconditional top-level return', () => {
    // for i in 0..4 { acc += x; return acc } — the loop runs <= 1x, so the later
    // copies would be statically unreachable. Left as a loop.
    const m = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(4)),
            (cb) => {
              cb.addAssign(acc, x)
              cb.ret(acc)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(1) // preserved
    oracleStable(m, 'f', [[0.5], [1]])
  })

  it('skips a body carrying a loop-level continue', () => {
    // for i in 0..4 { if (i > 2) { continue } acc += x } — no loop remains to continue.
    const m = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(4)),
            (cb, i) => {
              cb.if(i.gt(i32(2)), (c2) => {
                c2.continue()
              })
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(1) // preserved
    oracleStable(m, 'f', [[0.5], [1]])
  })

  it('skips a loop whose counter is shadowed by a body-local', () => {
    // for i in 0..4 { let i = 9; acc += x } — a body `let i` shadows the counter, so
    // the per-iteration literal could not be substituted soundly. Left as a loop.
    const m = module({
      funcs: [
        fn('f', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) => i.lt(i32(4)),
            (cb) => {
              cb.let('i', i32(9))
              cb.addAssign(acc, x)
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(countFors(unrollLoops(m))).toBe(1) // preserved — the shadow clobbers the counter name
  })
})
