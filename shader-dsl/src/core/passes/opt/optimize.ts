// ═══ Shader DSL — optimization pipeline (Optimization context) ═══
//
// optimize(module) runs an ordered list of correctness-preserving passes, each
// pure (module -> module). The headline value of the node IR: a real optimizing
// compiler, not a transliterator. Correctness is pinned by oracle value-equality
// (every pass must leave compileModule(m) producing identical results) and, once
// it lands (P3), the real-GPU f32 differential.
//
// STATUS — NOT wired into the emit path (intentionally deferred). emitModule
// (backends/wgsl.ts) runs only autoVars + cse from this context; the full pipeline
// (constProp / copyProp / constFold / algebraicSimplify / deadBranch / licm / dce)
// stays off until the real-GPU f32 differential gate (P3) lands, because the f64
// oracle alone cannot prove an optimizer preserves f32 behaviour. The value-MOVING
// passes (constProp / copyProp / deadBranch) are bit-exact and need no f32 gate;
// it is const-FOLD on floats that does, which is why the whole pipeline waits on P3
// together rather than wiring a partial subset early. Exercised today by the
// per-pass tests and runtime/.../dsl/optimize.test.ts (real projection module,
// oracle bit-equality) + playground/e2e/_optimizer-gpu-parity.spec.ts.

import type { ModuleDecl } from '../../ir'
import { constProp } from './const-prop'
import { copyProp } from './copy-prop'
import { constFold } from './const-fold'
import { algebraicSimplify } from './algebraic'
import { deadBranch } from './dead-branch'
import { cse } from './cse'
import { licm } from './licm'
import { dce } from './dce'

export type OptPass = (m: ModuleDecl) => ModuleDecl

/** The default pipeline. const/copy-prop first (move literals & copies into uses),
 *  then const-fold + algebraic-simplify (collapse the exposed literals / identities),
 *  then dead-branch (drop the control flow those literals decided), then CSE / LICM
 *  (hoist repeats & loop invariants), then DCE last (clean up everything orphaned). */
export const DEFAULT_PASSES: readonly OptPass[] = [constProp, copyProp, constFold, algebraicSimplify, deadBranch, cse, licm, dce]

export function optimize(m: ModuleDecl, passes: readonly OptPass[] = DEFAULT_PASSES): ModuleDecl {
  return passes.reduce((mod, pass) => pass(mod), m)
}

/** Run `passes` to a fixed point — until the module stops changing — capped at
 *  `maxIters`. One linear `optimize` sweep catches depth-1 chains (const-prop
 *  exposes a literal, const-fold collapses it, dead-branch drops the branch); this
 *  catches the deeper chains where a fold exposes the next propagation. Structural
 *  equality via JSON — the IR is plain, acyclic, function-free data. */
export function fixpoint(m: ModuleDecl, passes: readonly OptPass[] = DEFAULT_PASSES, maxIters = 8): ModuleDecl {
  let cur = m
  for (let i = 0; i < maxIters; i++) {
    const next = optimize(cur, passes)
    if (JSON.stringify(next) === JSON.stringify(cur)) return next
    cur = next
  }
  return cur
}
