import { describe, it, expect } from 'vitest'
import { autoInline } from './auto-inline'
import { module, fn, f32T, callFn, type ModuleDecl } from '../ir'
import { emitModule } from '../backends/wgsl'
import { compileModule } from '../oracle'

// #627 — cost-driven AUTO inlining over inlineFn. Inline a non-entry,
// non-recursive, single-return helper iff it is single-call (strict win) or its
// return is a leaf (param/lit/const — never bloats). Pinned by oracle equality.
describe('autoInline — cost-driven function inlining (#627)', () => {
  it('inlines a single-call helper and drops it', () => {
    const m = module({
      funcs: [
        fn('dbl', { x: f32T }, f32T, ({ x }, b) => { b.ret(x.mul(2)) }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => { b.ret(callFn('dbl', f32T, y.add(1))) }),
      ],
    })
    const out = autoInline(m)
    const wgsl = emitModule(out)
    expect(wgsl).not.toMatch(/\bdbl\(/)     // call site gone
    expect(wgsl).not.toContain('fn dbl')    // decl dropped
    expect(compileModule(out).fns.caller(5)).toBe(compileModule(m).fns.caller(5))
  })

  it('inlines a leaf (identity) helper even at multiple call sites', () => {
    const m = module({
      funcs: [
        fn('id', { x: f32T }, f32T, ({ x }, b) => { b.ret(x) }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => { b.ret(callFn('id', f32T, y).add(callFn('id', f32T, y.mul(3)))) }),
      ],
    })
    const out = autoInline(m)
    expect(emitModule(out)).not.toContain('fn id')
    expect(compileModule(out).fns.caller(2)).toBe(compileModule(m).fns.caller(2)) // 2 + 6 = 8
  })

  it('does NOT inline a multi-call non-leaf helper (the bloat guard)', () => {
    const m = module({
      funcs: [
        fn('poly', { x: f32T }, f32T, ({ x }, b) => { b.ret(x.mul(x).add(x)) }), // cost > 1
        fn('caller', { y: f32T }, f32T, ({ y }, b) => { b.ret(callFn('poly', f32T, y).add(callFn('poly', f32T, y.add(1)))) }),
      ],
    })
    expect(emitModule(autoInline(m))).toContain('fn poly') // 2 call sites, non-leaf -> kept
  })

  it('inlines a single-call helper INTO an entry point (entry is a caller, not a candidate)', () => {
    const m = module({
      funcs: [
        fn('dbl', { x: f32T }, f32T, ({ x }, b) => { b.ret(x.mul(2)) }),
        fn('main', { x: f32T }, f32T, ({ x }, b) => { b.ret(callFn('dbl', f32T, x)) }, { stage: 'fragment', retAttr: '@location(0)' }),
      ],
    })
    const wgsl = emitModule(autoInline(m))
    expect(wgsl).toContain('fn main(')
    expect(wgsl).not.toContain('fn dbl')
  })

  it('never inlines an entry point itself', () => {
    const m = module({
      funcs: [fn('main', { x: f32T }, f32T, ({ x }, b) => { b.ret(x.mul(2)) }, { stage: 'fragment', retAttr: '@location(0)' })],
    })
    expect(emitModule(autoInline(m))).toContain('fn main(')
  })

  it('bails out when any fn contains a raw Stmt (raw may call a helper textually)', () => {
    const base = module({ funcs: [fn('dbl', { x: f32T }, f32T, ({ x }, b) => { b.ret(x.mul(2)) })] })
    const withRaw: ModuleDecl = {
      ...base,
      funcs: [...base.funcs, { name: 'rawfn', params: [], ret: f32T, body: [{ s: 'raw', wgsl: 'return dbl(1.0);' }] }],
    }
    expect(emitModule(autoInline(withRaw))).toContain('fn dbl') // dbl called only in raw -> untouched
  })

  it('leaves a recursive single-return fn alone', () => {
    const m = module({
      funcs: [
        fn('rec', { x: f32T }, f32T, ({ x }, _b) => callFn('rec', f32T, x), { lintDisable: ['no-recursion'] }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => { b.ret(callFn('rec', f32T, y)) }),
      ],
    })
    expect(emitModule(autoInline(m))).toContain('fn rec')
  })
})
