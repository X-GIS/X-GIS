import { describe, it, expect } from 'vitest'
import { cse } from './index.js'
import {
  module,
  fn,
  f32T,
  i32T,
  u32T,
  boolT,
  sin,
  cos,
  type Stmt,
  type Expr,
  type ModuleDecl,
  type ShaderType,
} from '../../ir/index.js'
import { emitModule } from '../../backends/wgsl.js'
import { compileModule } from '../../oracle.js'

// P2 — common-subexpression elimination (as a PASS over the IR, not an authoring
// change). Safe subset: hoist a compound subexpression that (a) occurs >= 2x and
// (b) depends only on fn inputs (params/consts/bindings, no local let) into a single
// `let` at the shallowest point that still dominates every use, replacing each
// occurrence with a varref. A fn containing a raw Stmt is skipped (raw WGSL is opaque).
describe('optimize — common-subexpression elimination', () => {
  it('hoists a repeated compound subexpr into one shared temp', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(sin(x).add(sin(x)))
        }),
      ],
    })
    const wgsl = emitModule(cse(m))
    expect(wgsl).toContain('_cse') // a hoisted temp was introduced
    expect((wgsl.match(/sin\(x\)/g) ?? []).length).toBe(1) // sin(x) computed once
  })

  it('does not hoist a non-repeated expr', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(sin(x).add(1))
        }),
      ],
    })
    expect(emitModule(cse(m))).not.toContain('_cse')
  })

  it('preserves oracle value-equality', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(sin(x).add(sin(x)))
        }),
      ],
    })
    expect(compileModule(cse(m)).fns.k(0.5)).toBeCloseTo(compileModule(m).fns.k(0.5) as number, 10)
  })

  it('skips a fn containing a raw Stmt (does not crash, leaves it alone)', () => {
    const m: ModuleDecl = module({
      funcs: [
        {
          name: 'rf',
          params: [],
          ret: f32T,
          body: [{ s: 'raw', wgsl: 'return sin(1.0) + sin(1.0);' } as Stmt],
        },
      ],
    })
    expect(() => emitModule(cse(m))).not.toThrow()
    expect(emitModule(cse(m))).not.toContain('_cse')
  })

  it('a second cse pass does not redeclare _cse0 (idempotent temp naming)', () => {
    // sin(cos(x)) twice + cos(x) once: cse#1 hoists the maximal sin(cos(x)) to
    // _cse0 but leaves cos(x) repeated (it occurs nested AND standalone); cse#2
    // must hoist cos(x) as _cse1, never a colliding _cse0. Guards the
    // optimize()->emitModule() double-cse path the optimizer GPU-parity gate runs.
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(
            sin(cos(x))
              .add(sin(cos(x)))
              .add(cos(x)),
          )
        }),
      ],
    })
    const twice = cse(cse(m))
    const wgsl = emitModule(twice)
    expect((wgsl.match(/let _cse0\b/g) ?? []).length).toBe(1) // _cse0 declared exactly once
    expect(compileModule(twice).fns.k(0.5)).toBeCloseTo(compileModule(m).fns.k(0.5) as number, 10)
  })
})

// ── Placement: the shallowest point that still dominates every use ──
//
// Dedup is a SOURCE win; running the value is a per-invocation COST. A temp parked
// at the fn top is paid by every invocation even when all its uses sit inside one
// mutually-exclusive branch — which is how fs_hillshade's 5-way `hillshade-method`
// dispatch came to run all five methods' prerequisites on every fragment (measured:
// all five methods cost the SAME, and cutting the dispatch cut ~52 % of hillshade's
// fragment cost over an identical raster draw). These assertions pin the placement
// rule itself; the oracle checks pin that placement never changes a VALUE.
describe('optimize — CSE placement', () => {
  const P: Expr = { op: 'param', type: f32T, name: 'x' }
  const lit = (value: number): Expr => ({ op: 'lit', type: f32T, value })
  const varref = (name: string): Expr => ({ op: 'varref', type: f32T, name })
  const add = (a: Expr, b: Expr): Expr => ({ op: 'binop', type: f32T, bop: '+', a, b })
  // A RUNTIME condition (x > 0). A literal one would be folded away by dead-branch —
  // emitModule runs the whole optimizer fixpoint, not cse alone — and there would be
  // no block left to observe placement against.
  const XGT0: Expr = { op: 'compare', type: boolT, cop: '>', a: P, b: lit(0) }
  // sin(x) built as raw IR so the arms can be hand-placed.
  const sinX: Expr = { op: 'call', type: f32T, fn: 'sin', args: [P] }
  const letS = (name: string, expr: Expr): Stmt => ({ s: 'let', name, expr })

  const emitOf = (body: Stmt[]): string =>
    emitModule(
      cse(
        module({
          funcs: [{ name: 'k', params: [{ name: 'x', type: f32T }], ret: f32T, body }],
        }) as ModuleDecl,
      ),
    )
  const lineOf = (wgsl: string, re: RegExp): number => wgsl.split('\n').findIndex((l) => re.test(l))

  it('binds inside the arm when every use is in that one arm', () => {
    // sin(x) twice, both inside the `if` arm — hoisting to fn top would make the
    // else path pay for it.
    const wgsl = emitOf([
      { s: 'var', name: 'r', type: f32T, init: lit(0) },
      {
        s: 'if',
        arms: [
          {
            cond: XGT0,
            body: [
              letS('a', add(sinX, sinX)),
              { s: 'assign', target: varref('r'), expr: varref('a') },
            ],
          },
        ],
        elseBody: [{ s: 'assign', target: varref('r'), expr: lit(1) }],
      },
      { s: 'return', expr: varref('r') },
    ])
    expect(wgsl).toContain('_cse') // it was still deduped
    // The temp must be declared INSIDE the if block, i.e. after the `if (` line.
    const cseLine = lineOf(wgsl, /let _cse\d+ =/)
    const ifLine = lineOf(wgsl, /^\s*if \(/)
    expect(ifLine).toBeGreaterThanOrEqual(0)
    expect(cseLine).toBeGreaterThan(ifLine)
  })

  it('binds at the fn body when uses straddle two arms (common dominator)', () => {
    const wgsl = emitOf([
      { s: 'var', name: 'r', type: f32T, init: lit(0) },
      {
        s: 'if',
        arms: [{ cond: XGT0, body: [{ s: 'assign', target: varref('r'), expr: sinX }] }],
        elseBody: [{ s: 'assign', target: varref('r'), expr: sinX }],
      },
      { s: 'return', expr: varref('r') },
    ])
    const cseLine = lineOf(wgsl, /let _cse\d+ =/)
    const ifLine = lineOf(wgsl, /^\s*if \(/)
    expect(cseLine).toBeGreaterThanOrEqual(0)
    expect(cseLine).toBeLessThan(ifLine) // hoisted ABOVE the branch, as it must be
  })

  it('never binds inside a loop body (LICM owns loop-invariant motion)', () => {
    const wgsl = emitOf([
      { s: 'var', name: 'r', type: f32T, init: lit(0) },
      {
        s: 'for',
        init: { s: 'var', name: 'i', type: f32T, init: lit(0) },
        cond: {
          op: 'compare',
          type: boolT,
          cop: '<',
          a: varref('i'),
          b: lit(3),
        },
        update: {
          s: 'assign',
          target: varref('i'),
          expr: add(varref('i'), lit(1)),
        },
        body: [{ s: 'assign', target: varref('r'), expr: add(sinX, sinX) }],
      },
      { s: 'return', expr: varref('r') },
    ])
    const cseLine = lineOf(wgsl, /let _cse\d+ =/)
    const forLine = lineOf(wgsl, /^\s*for \(/)
    expect(cseLine).toBeGreaterThanOrEqual(0)
    expect(forLine).toBeGreaterThanOrEqual(0)
    expect(cseLine).toBeLessThan(forLine) // outside the loop, not re-evaluated per iteration
  })

  it('preserves oracle value-equality across a branchy function', () => {
    const build = (): ModuleDecl =>
      module({
        funcs: [
          fn('k', { x: f32T }, f32T, ({ x }, b) => {
            // Two arms with their own repeats + one repeat shared by both.
            b.ret(sin(x).add(sin(x)).add(cos(x)).add(cos(x)))
          }),
        ],
      })
    const m = build()
    for (const v of [0, 0.5, -1.25, 3.75]) {
      expect(compileModule(cse(m)).fns.k(v)).toBeCloseTo(compileModule(m).fns.k(v) as number, 12)
    }
  })

  // #2408 — a literal's TYPE is part of its identity. `keyOf` used to spell a literal as
  // `typeof e.value` (always 'number') plus its value, so `u32(-1.0)` and `u32(-1)` shared a
  // key and CSE rewrote one into the other — in the emitted WGSL and GLSL, not just on the
  // CPU tier. The two conversions genuinely differ: float→uint saturates to 0, int→uint
  // reinterprets the bits as 4294967295. Found by the #2406 generated-program differential.
  it('#2408: does not merge two literals that differ only in type', () => {
    const u32Lit = (type: ShaderType, value: number): Expr => ({
      op: 'call',
      type: u32T,
      fn: 'u32',
      args: [{ op: 'lit', type, value }],
    })
    const m: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        {
          name: 'both',
          params: [],
          ret: u32T,
          attrs: [],
          body: [
            { s: 'var', name: 'a', type: u32T, init: u32Lit(f32T, -1) },
            { s: 'var', name: 'b', type: u32T, init: u32Lit(i32T, -1) },
            {
              s: 'return',
              expr: {
                op: 'binop',
                type: u32T,
                bop: '-',
                a: { op: 'varref', type: u32T, name: 'a' },
                b: { op: 'varref', type: u32T, name: 'b' },
              },
            },
          ],
        },
      ],
    }
    // 0 - 4294967295 wraps to 1 in u32. Merging the two makes it 0.
    expect(compileModule(m).fns.both!()).toBe(1)
    expect(compileModule(cse(m)).fns.both!()).toBe(1)
    // and the emitted text keeps both spellings, which is where the damage was visible.
    const wgsl = emitModule(cse(m))
    expect(wgsl).toContain('u32(-1.0)')
    expect(wgsl).toContain('u32(-1)')
  })

  // The same key loss on the other side: `String(-0)` is `"0"`.
  it('#2408: does not merge -0.0 with 0.0', () => {
    const lit = (value: number): Expr => ({ op: 'lit', type: f32T, value })
    const add = (name: string, value: number): Stmt => ({
      s: 'var',
      name,
      type: f32T,
      init: {
        op: 'binop',
        type: f32T,
        bop: '+',
        a: { op: 'param', type: f32T, name: 'x' },
        b: lit(value),
      },
    })
    const m: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        {
          name: 'k',
          params: [{ name: 'x', type: f32T }],
          ret: f32T,
          attrs: [],
          body: [
            add('p', 0),
            add('n', -0),
            {
              s: 'return',
              expr: {
                op: 'binop',
                type: f32T,
                bop: '/',
                a: lit(1),
                b: { op: 'varref', type: f32T, name: 'n' },
              },
            },
          ],
        },
      ],
    }
    // At x = -0: `x + 0.0` is +0 and `x + -0.0` is -0. Reciprocals are the cheapest way to
    // SEE that sign — +Infinity vs -Infinity — because comparing the zeros themselves is
    // blind (`+0 - -0` is `+0` either way, which is how the first version of this test
    // passed against the very key it was written to reject).
    expect(compileModule(m).fns.k!(-0)).toBe(-Infinity)
    expect(compileModule(cse(m)).fns.k!(-0)).toBe(-Infinity)
  })
})
