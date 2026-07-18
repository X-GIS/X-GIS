// ═══ fixpoint convergence equality (irEqual) — #1186 ═══
//
// irEqual replaced `JSON.stringify(a) === JSON.stringify(b)` as fixpoint's
// convergence test (188 MB of JSON per demo pipeline-compile pass on the merged
// multi-projection modules). It must agree with the string form on the IR
// shapes fixpoint ever compares: plain, acyclic, function-free data. irEqual is
// internal, so these assert its behaviour through fixpoint's observable
// contract; the end-to-end proof is the emit-goldens + polygon-variant-diff
// byte gates.

import { describe, it, expect } from 'vitest'
import { fixpoint, optimize } from './optimize'
import { module, fn, f32, f32T } from '../../ir'
import { emitModule } from '../../backends/wgsl'

/** The pre-#1186 semantics `fixpoint` replaced: sweep the WHOLE module to a fixed
 *  point. The reference the per-function `fixpoint` must match byte-for-byte. */
function wholeModuleFixpoint(m: ReturnType<typeof optimize>): ReturnType<typeof optimize> {
  let cur = m
  for (let i = 0; i < 8; i++) {
    const next = optimize(cur)
    if (JSON.stringify(next) === JSON.stringify(cur)) return next
    cur = next
  }
  return cur
}

describe('fixpoint convergence (irEqual)', () => {
  it('folds a nested constant chain and lands on a fixed point', () => {
    // (2 + 3) * 4 — const-fold + propagation take several sweeps; irEqual must
    // detect convergence (not loop to the maxIters cap) AND the result must be a
    // true fixed point: re-running fixpoint is a no-op.
    const m = module({
      funcs: [
        fn('k', {}, f32T, (_p, b) => {
          b.ret(f32(2).add(3).mul(4))
        }),
      ],
    })
    const once = fixpoint(m)
    expect(emitModule(once)).toContain('20.0') // proved it actually folded
    expect(JSON.stringify(fixpoint(once))).toBe(JSON.stringify(once)) // idempotent
  })

  it('treats a distinct-reference structural clone as converged', () => {
    // The exact path irEqual exists for: fixpoint's passes return FRESH trees, so
    // convergence is "structurally equal, different reference" — a JSON clone.
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(2))
        }),
      ],
    })
    const opt = fixpoint(m)
    const clone = JSON.parse(JSON.stringify(opt))
    expect(JSON.stringify(fixpoint(clone))).toBe(JSON.stringify(opt))
  })

  it('per-function fixpoint is byte-identical to whole-module fixpoint (invariant guard)', () => {
    // fixpoint optimizes each function INDEPENDENTLY, which is correct only while
    // every pass is per-function-pure. A module of functions with UNEVEN
    // convergence — a deep const-fold chain, a copy chain, a trivial identity — so
    // per-function and whole-module take different sweep counts yet must land on
    // the SAME result. Wiring a CROSS-function pass (inline/gvn/deadFnElim) would
    // make the two diverge and fail here loudly, not silently in shipped shaders.
    const raw = module({
      funcs: [
        fn('deep', {}, f32T, (_p, b) => {
          b.ret(f32(2).add(3).mul(4).add(f32(1).mul(5)))
        }),
        fn('copy', { x: f32T }, f32T, ({ x }, b) => {
          const y = b.let('y', x)
          const z = b.let('z', y)
          b.ret(z.add(1))
        }),
        fn('id', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x)
        }),
      ],
    })
    // Materialize handle funcs -> plain decls once so both drivers see identical input.
    const mat = optimize(raw)
    expect(JSON.stringify(fixpoint(mat))).toBe(JSON.stringify(wholeModuleFixpoint(mat)))
  })
})
