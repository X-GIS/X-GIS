import { describe, it, expect } from 'vitest'
import { autoInline, inlineAll } from './auto-inline'
import { module, fn, f32T, callFn, toF32, toF64, type ModuleDecl } from '../ir'
import { emitModule } from '../backends/wgsl'
import { compileModule } from '../oracle'

// #627 — cost-driven AUTO inlining over inlineFn. Inline a non-entry,
// non-recursive, single-return helper iff it is single-call (strict win) or its
// return is a leaf (param/lit/const — never bloats). Pinned by oracle equality.
describe('autoInline — cost-driven function inlining (#627)', () => {
  it('inlines a single-call helper and drops it', () => {
    const m = module({
      funcs: [
        fn('dbl', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(2))
        }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => {
          b.ret(callFn('dbl', f32T, y.add(1)))
        }),
      ],
    })
    const out = autoInline(m)
    const wgsl = emitModule(out)
    expect(wgsl).not.toMatch(/\bdbl\(/) // call site gone
    expect(wgsl).not.toContain('fn dbl') // decl dropped
    expect(compileModule(out).fns.caller(5)).toBe(compileModule(m).fns.caller(5))
  })

  it('inlines a leaf (identity) helper even at multiple call sites', () => {
    const m = module({
      funcs: [
        fn('id', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x)
        }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => {
          b.ret(callFn('id', f32T, y).add(callFn('id', f32T, y.mul(3))))
        }),
      ],
    })
    const out = autoInline(m)
    expect(emitModule(out)).not.toContain('fn id')
    expect(compileModule(out).fns.caller(2)).toBe(compileModule(m).fns.caller(2)) // 2 + 6 = 8
  })

  it('does NOT inline a multi-call non-leaf helper (the bloat guard)', () => {
    const m = module({
      funcs: [
        fn('poly', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(x).add(x))
        }), // cost > 1
        fn('caller', { y: f32T }, f32T, ({ y }, b) => {
          b.ret(callFn('poly', f32T, y).add(callFn('poly', f32T, y.add(1))))
        }),
      ],
    })
    expect(emitModule(autoInline(m))).toContain('fn poly') // 2 call sites, non-leaf -> kept
  })

  it('inlines a single-call helper INTO an entry point (entry is a caller, not a candidate)', () => {
    const m = module({
      funcs: [
        fn('dbl', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(2))
        }),
        fn(
          'main',
          { x: f32T },
          f32T,
          ({ x }, b) => {
            b.ret(callFn('dbl', f32T, x))
          },
          { stage: 'fragment', retAttr: '@location(0)' },
        ),
      ],
    })
    const wgsl = emitModule(autoInline(m))
    expect(wgsl).toContain('fn main(')
    expect(wgsl).not.toContain('fn dbl')
  })

  it('never inlines an entry point itself', () => {
    const m = module({
      funcs: [
        fn(
          'main',
          { x: f32T },
          f32T,
          ({ x }, b) => {
            b.ret(x.mul(2))
          },
          { stage: 'fragment', retAttr: '@location(0)' },
        ),
      ],
    })
    expect(emitModule(autoInline(m))).toContain('fn main(')
  })

  it('bails out when any fn contains a raw Stmt (raw may call a helper textually)', () => {
    const base = module({
      funcs: [
        fn('dbl', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(2))
        }),
      ],
    })
    const withRaw: ModuleDecl = {
      ...base,
      funcs: [
        ...base.funcs,
        { name: 'rawfn', params: [], ret: f32T, body: [{ s: 'raw', wgsl: 'return dbl(1.0);' }] },
      ],
    }
    expect(emitModule(autoInline(withRaw))).toContain('fn dbl') // dbl called only in raw -> untouched
  })

  it('leaves a recursive single-return fn alone', () => {
    const m = module({
      funcs: [
        fn('rec', { x: f32T }, f32T, ({ x }, _b) => callFn('rec', f32T, x), {
          lintDisable: ['no-recursion'],
        }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => {
          b.ret(callFn('rec', f32T, y))
        }),
      ],
    })
    expect(emitModule(autoInline(m))).toContain('fn rec')
  })
})

// inlineAll — the OBFUSCATION variant (emit-prod's inline() plugin): every
// safely-inlinable single-return helper vanishes, regardless of call count, so
// the call graph flattens. Same safety filter as autoInline (df64 / entry /
// recursive / multi-statement excluded); value-equality inherited from inlineFn.
describe('inlineAll — call-graph flattening for obfuscation', () => {
  it('inlines a MULTI-CALL single-return helper the size heuristic would keep', () => {
    const m = module({
      funcs: [
        fn('shade', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(0.5).add(0.5))
        }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => {
          b.ret(callFn('shade', f32T, y).add(callFn('shade', f32T, y.mul(2))))
        }),
      ],
    })
    // autoInline keeps `shade` (multi-call, non-leaf — the bloat guard);
    // inlineAll erases it.
    expect(emitModule(autoInline(m))).toContain('fn shade')
    const out = inlineAll(m)
    const wgsl = emitModule(out)
    expect(wgsl).not.toMatch(/\bshade\(/)
    expect(wgsl).not.toContain('fn shade')
    expect(compileModule(out).fns.caller(3) as number).toBeCloseTo(
      compileModule(m).fns.caller(3) as number,
      6,
    )
  })

  it('leaves a MULTI-STATEMENT helper intact (inlineFn is single-return only)', () => {
    const m = module({
      funcs: [
        fn('twostep', { x: f32T }, f32T, ({ x }, b) => {
          const t = b.let('t', x.mul(2)) // a `let` before the return → not single-return
          b.ret(t.add(1))
        }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => {
          b.ret(callFn('twostep', f32T, y))
        }),
      ],
    })
    expect(emitModule(inlineAll(m))).toContain('fn twostep')
  })

  it('never inlines the df64 emulation library (the opacity invariant holds)', () => {
    // An f64 add lowers (inside emit) to df64_add → df64_twoSum, single-return
    // helpers inline() would otherwise flatten. The df64_ prefix filter must
    // keep them as opaque calls even under the aggressive pass.
    const mf = module({
      funcs: [
        fn('kf', { a: f32T }, f32T, ({ a }, b) => {
          b.ret(toF32(toF64(a).add(toF64(a))))
        }),
      ],
    })
    const wgsl = emitModule(mf, { plugins: [{ name: 'inline', transformIR: inlineAll }] })
    expect(wgsl).toContain('df64_add(') // call site survives (not inlined)
    expect(wgsl).toContain('fn df64_add') // decl survives
    expect(wgsl).toContain('fn df64_twoSum') // transitive df64 helper survives too
  })
})
