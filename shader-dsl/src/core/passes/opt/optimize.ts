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
import { cseLocal } from './cse-local'
import { licm } from './licm'
import { dce } from './dce'

export type OptPass = (m: ModuleDecl) => ModuleDecl

/** The default pipeline. const/copy-prop first (move literals & copies into uses),
 *  then const-fold + algebraic-simplify (collapse the exposed literals / identities),
 *  then dead-branch (drop the control flow those literals decided), then CSE (fn-top
 *  input-only repeats) + cse-local (statement-local repeats that touch a local/var) /
 *  LICM (loop invariants), then DCE last (clean up everything orphaned). */
export const DEFAULT_PASSES: readonly OptPass[] = [constProp, copyProp, constFold, algebraicSimplify, deadBranch, cse, cseLocal, licm, dce]

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

// ── Named optimization levels (C-compiler -O0/-O1/-O2) ──
// emit hardcodes the full pipeline (`be.optimize = fixpoint(m)` = O2). These named
// tiers expose the intermediate points so a consumer can emit a debug build (O0,
// naive — every author-written subexpr verbatim) or a bit-exact build (O1) and, in
// particular, so the measurement util can A/B the optimizer's effect (O0 vs O2).
export type OptLevel = 'O0' | 'O1' | 'O2'

/** The pass list each level runs to a fixed point.
 *  • O0 — none. Naive lowered emit (debug / the size baseline the optimizer is measured against).
 *  • O1 — the bit-exact value-MOVERS + cleanup only: const/copy-prop, dead-branch, cse, cse-local, dce.
 *    None changes WHICH float ops execute, so O1's RUNTIME VALUES are bit-identical to O0 on every
 *    target. (cse / cse-local may rewrite the SOURCE — hoist a repeat to a `let` — but never the
 *    result; that source-vs-result split is exactly what measure.ts's "bytes ≠ work" surfaces.) It
 *    deliberately omits const-FOLD on floats, algebraic identities, and LICM — the passes that can
 *    change float semantics and so need the real-GPU f32 differential gate (P3).
 *  • O2 — the full DEFAULT_PASSES (adds constFold + algebraicSimplify + licm). The emit default;
 *    `optimizeAt(m,'O2')` is identical to every backend's `optimize: (m) => fixpoint(m)`. */
export const LEVEL_PASSES: Record<OptLevel, readonly OptPass[]> = {
  O0: [],
  O1: [constProp, copyProp, deadBranch, cse, cseLocal, dce],
  O2: DEFAULT_PASSES,
}

/** Optimize a module at a named level (fixpoint of that level's passes). O0 is identity. */
export function optimizeAt(m: ModuleDecl, level: OptLevel): ModuleDecl {
  return level === 'O0' ? m : fixpoint(m, LEVEL_PASSES[level])
}
