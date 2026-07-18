// ═══ Shader DSL — optimization pipeline (Optimization context) ═══
//
// optimize(module) runs an ordered list of correctness-preserving passes, each
// pure (module -> module). The headline value of the node IR: a real optimizing
// compiler, not a transliterator. Correctness is pinned by oracle value-equality
// (every pass must leave compileModule(m) producing identical results) and, once
// it lands (P3), the real-GPU f32 differential.
//
// STATUS — WIRED into BOTH emit paths (#763 H1; this header long claimed "deferred
// until P3" after P3 had landed). emitModule (backends/wgsl.ts `optimize:`) and
// emitGlslModule (backends/glsl.ts `optimize:`) each run the full `fixpoint` pipeline
// over the lowered module on EVERY emit. The f32 concern that once gated the wiring
// is answered by the real-GPU differential (playground/e2e/_optimizer-gpu-parity.spec.ts,
// in CI); correctness is further pinned by the per-pass oracle tests, the projection
// module's oracle bit-equality loop over every proj_* fn
// (map/src/shaders/dsl/optimize.test.ts), and the examples emit-goldens byte gate.

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
 *  LICM (loop invariants), then DCE last (clean up everything orphaned).
 *
 *  NB: whole-function tree-shaking (`deadFnElim`, ./dce-fns), cross-statement
 *  value numbering (`gvn`, ./gvn — #763 H8), and small fixed-count loop unrolling
 *  (`unrollLoops`, ./unroll — #627) are deliberately NOT in this list — like
 *  `inlineFn` (../inline), they are available-but-unwired passes. The shaders that
 *  share a projection prelude emit it as one module of helper fns + the entry
 *  points, so tree-shaking would per-shader-prune the prelude and break the
 *  deliberately byte-stable shared-prelude emit (+ its golden-WGSL drift gate); gvn
 *  moves value construction across statements, and unrollLoops duplicates a loop
 *  body — both likewise perturb emitted bytes. Wire any only behind a maintainer
 *  decision to regenerate those snapshots. */
export const DEFAULT_PASSES: readonly OptPass[] = [
  constProp,
  copyProp,
  constFold,
  algebraicSimplify,
  deadBranch,
  cse,
  cseLocal,
  licm,
  dce,
]

export function optimize(m: ModuleDecl, passes: readonly OptPass[] = DEFAULT_PASSES): ModuleDecl {
  return passes.reduce((mod, pass) => pass(mod), m)
}

/** Structural equality over the IR, mirroring the `JSON.stringify(a) ===
 *  JSON.stringify(b)` test it replaces — but SHORT-CIRCUITING at the first
 *  difference and allocating NOTHING. The IR is plain, acyclic, function-free
 *  data (the `fixpoint` invariant), so a lockstep walk is exact:
 *   • primitives compare by `===`;
 *   • arrays compare by length then element-wise (ordered — matches JSON);
 *   • plain objects compare by their DEFINED-value key set then value-wise —
 *     `JSON.stringify` omits `undefined`-valued keys, so both sides filter them
 *     to keep the comparison identical to the string form it replaced.
 *  Object key ORDER is not compared: the emitter reads IR fields by name, so a
 *  key-order-only difference can never reach emitted bytes — pinned by the
 *  emit-goldens + polygon-variant-diff byte gates. */
function irEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const aa = a as unknown[]
    const ba = b as unknown[]
    if (aa.length !== ba.length) return false
    for (let i = 0; i < aa.length; i++) if (!irEqual(aa[i], ba[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined)
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined)
  if (ak.length !== bk.length) return false
  // A key defined on `a` but absent/undefined on `b` fails via irEqual(x, undefined).
  for (const k of ak) if (!irEqual(ao[k], bo[k])) return false
  return true
}

/** Run `passes` to a fixed point — until the module stops changing — capped at
 *  `maxIters`. One linear `optimize` sweep catches depth-1 chains (const-prop
 *  exposes a literal, const-fold collapses it, dead-branch drops the branch); this
 *  catches the deeper chains where a fold exposes the next propagation.
 *
 *  Convergence is tested by `irEqual`, a short-circuiting structural walk. It
 *  replaced a `JSON.stringify(next) === JSON.stringify(cur)` check that, on the
 *  merged multi-projection modules, serialized ~1.7 MB of JSON PER sweep (188 MB
 *  across a demo's pipeline compiles — #1186); the walk bails at the first
 *  differing node on the many non-converging sweeps and allocates nothing. */
export function fixpoint(
  m: ModuleDecl,
  passes: readonly OptPass[] = DEFAULT_PASSES,
  maxIters = 8,
): ModuleDecl {
  let cur = m
  for (let i = 0; i < maxIters; i++) {
    const next = optimize(cur, passes)
    if (irEqual(next, cur)) return next
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
