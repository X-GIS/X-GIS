import { describe, it, expect } from 'vitest'
import { deadFnElim } from './index'
import { module, fn, callFn, f32, f32T, type Expr, type FuncDecl, type ModuleDecl } from '../../ir'
import { emitModule } from '../../backends/wgsl'

// Whole-FUNCTION tree-shaking: drop functions unreachable from the entry
// points. Roots = fns with a non-empty `attrs` (@vertex/@fragment/@compute);
// edges = `call` Exprs naming another module fn. Removal-only, so bit-exact.
//
// These tests author FuncDecl IR directly (full control over attrs + call
// graph) and assert which fns survive; the last two go through the real
// builder + emit path to prove the production pipeline tree-shakes.

const lit = (v: number): Expr => ({ op: 'lit', type: f32T, value: v })
const call = (name: string, ...args: Expr[]): Expr => ({ op: 'call', type: f32T, fn: name, args })
const helper = (name: string, ret: Expr): FuncDecl => ({
  name,
  params: [],
  ret: f32T,
  body: [{ s: 'return', expr: ret }],
})
const entry = (name: string, ret: Expr): FuncDecl => ({
  ...helper(name, ret),
  attrs: ['@fragment'],
  retAttr: '@location(0)',
})
const mod = (funcs: FuncDecl[]): ModuleDecl => ({ consts: [], structs: [], bindings: [], funcs })
const names = (m: ModuleDecl): string[] => m.funcs.map((f) => f.name)

describe('optimize — dead-function elimination (tree-shaking)', () => {
  it('drops a helper no entry point can reach', () => {
    const m = mod([entry('main', call('used')), helper('used', lit(1)), helper('dead', lit(2))])
    expect(names(deadFnElim(m))).toEqual(['main', 'used'])
  })

  it('keeps transitively-reachable helpers (main -> a -> b)', () => {
    const m = mod([
      entry('main', call('a')),
      helper('a', call('b')),
      helper('b', lit(1)),
      helper('dead', lit(2)),
    ])
    expect(names(deadFnElim(m)).sort()).toEqual(['a', 'b', 'main'])
  })

  it('follows a call nested inside an expression, not just a bare return', () => {
    const m = mod([
      entry('main', { op: 'binop', bop: '+', type: f32T, a: call('pred'), b: lit(1) }),
      helper('pred', lit(1)),
      helper('dead', lit(2)),
    ])
    expect(names(deadFnElim(m))).toEqual(['main', 'pred'])
  })

  it('is a no-op when there are no entry points (helper-only func list)', () => {
    // Guards the emitFuncsCsed parity-harness path: a bare helper list has no
    // root, so reachability is undefined -> keep everything.
    const m = mod([helper('a', lit(1)), helper('b', lit(2))])
    expect(names(deadFnElim(m))).toEqual(['a', 'b'])
  })

  it('bails out entirely if any fn contains a raw Stmt (raw may call a helper textually)', () => {
    const m = mod([
      entry('main', lit(0)), // does NOT call `maybe`
      { name: 'maybe', params: [], ret: f32T, body: [{ s: 'raw', wgsl: 'return 1.0;' }] },
    ])
    expect(names(deadFnElim(m))).toEqual(['main', 'maybe'])
  })

  it('returns the module unchanged when nothing is unreachable', () => {
    const m = mod([entry('main', call('used')), helper('used', lit(1))])
    expect(deadFnElim(m)).toBe(m)
  })

  it('tree-shakes a dead helper out of the emitted WGSL (applied before emit)', () => {
    // Authored through the real builder. deadFnElim is an available-but-unwired
    // pass (NOT in emitModule's default pipeline — see DEFAULT_PASSES), so apply
    // it explicitly. `unused` is declared but never called -> dropped; `used`
    // (called by the `main` entry point) and `main` survive + still emit.
    const m = module({
      funcs: [
        fn('used', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(2))
        }),
        fn('unused', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.add(f32(99)))
        }),
        fn(
          'main',
          { x: f32T },
          f32T,
          ({ x }, b) => {
            b.ret(callFn('used', f32T, x))
          },
          { stage: 'fragment', retAttr: '@location(0)' },
        ),
      ],
    })
    const wgsl = emitModule(deadFnElim(m))
    expect(wgsl).toContain('fn used(')
    expect(wgsl).toContain('fn main(')
    expect(wgsl).not.toContain('fn unused(')
    expect(wgsl).not.toContain('99')
  })
})
