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

import type { ModuleDecl, FuncDecl } from '../../ir/index.js'
import { constProp } from './const-prop.js'
import { copyProp } from './copy-prop.js'
import { constFold } from './const-fold.js'
import { algebraicSimplify } from './algebraic.js'
import { deadBranch } from './dead-branch.js'
import { cse } from './cse.js'
import { cseLocal } from './cse-local.js'
import { gvn } from './gvn.js'
import { structCtor } from './struct-ctor.js'
import { licm } from './licm.js'
import { dce } from './dce.js'

export type OptPass = (m: ModuleDecl) => ModuleDecl

/** The default pipeline. const/copy-prop first (move literals & copies into uses),
 *  then const-fold + algebraic-simplify (collapse the exposed literals / identities),
 *  then dead-branch (drop the control flow those literals decided), then CSE (fn-top
 *  input-only repeats) + cse-local (statement-local repeats that touch a local/var) /
 *  LICM (loop invariants), then DCE last (clean up everything orphaned).
 *
 *  `gvn` completes the CSE family here (#1865): `cse` owns fn-top input-only repeats
 *  and `cseLocal` owns repeats inside ONE statement, which leaves the repeat that
 *  touches a local and spans STATEMENTS — the commonest shape in the real shaders —
 *  to nobody. It was long left unwired because it perturbs emitted bytes, and the
 *  snapshots were regenerated when the measurement made the case: on the production
 *  modules it removes 208 of 6008 IR ops (line 1546 -> 1465, hillshade 657 -> 613,
 *  both per-fragment hot paths). Pure dedup, so the values are bit-identical — the
 *  re-bake moved bytes, never pixels.
 *
 *  `structCtor` sits before them (#1867): it collapses a write-once struct local — the
 *  `Out.var()` + field-assigns + `return o` shape every ioStruct body authors — into the
 *  constructor, so the CSE family below sees the final statement shape rather than a
 *  scatter it cannot dedupe across. Value-safe verbatim: the field expressions are moved
 *  into the ctor unchanged and in field order, which a constructor evaluates in the same
 *  order the assignments ran. It composes with GLSL legalisation rather than fighting it —
 *  a discarding call this collapse moves INTO a ctor is exactly the shape
 *  `backends/glsl-legalize.ts` exists to hoist back out, pinned by a case there.
 *
 *  NB: whole-function tree-shaking (`deadFnElim`, ./dce-fns) and small fixed-count
 *  loop unrolling (`unrollLoops`, ./unroll — #627) are still deliberately NOT in
 *  this list — like `inlineFn` (../inline), they are available-but-unwired passes.
 *  The shaders that share a projection prelude emit it as one module of helper fns
 *  + the entry points, so tree-shaking would per-shader-prune the prelude and break
 *  the deliberately byte-stable shared-prelude emit (+ its golden-WGSL drift gate);
 *  unrollLoops duplicates a loop body, likewise perturbing emitted bytes. Wire
 *  either only behind a maintainer decision to regenerate those snapshots. */
export const DEFAULT_PASSES: readonly OptPass[] = [
  constProp,
  copyProp,
  constFold,
  algebraicSimplify,
  deadBranch,
  structCtor,
  cse,
  cseLocal,
  gvn,
  licm,
  dce,
]

/** Run an optimizer pass list over a module ONCE, in order, and return the result. Pure — the
 *  input module is not mutated.
 *
 *  This is the single-sweep primitive. Passes feed each other (const-prop exposes folds, which
 *  expose dead branches, which expose dead code), so one sweep generally leaves further wins on
 *  the table; `fixpoint()` is the same list re-run until the module stops changing, and is what
 *  every backend's own `optimize` hook uses. Reach for `optimize` directly when you want exactly
 *  one pass over a known list — measuring an individual pass's effect, or reproducing a
 *  specific intermediate state.
 *
 *  Prefer `optimizeAt(m, level)` when you want a NAMED tier: {@link OptLevel} `'O1'` is the
 *  bit-exact set, `'O2'` the full one, and those two differ in whether float semantics can move
 *  at all — a distinction a hand-assembled pass list is easy to get wrong.
 *
 *  Exported from `@xgis/shader-dsl/dev`.
 *
 *  @example
 *  ```ts
 *  import { optimize, DEFAULT_PASSES } from '@xgis/shader-dsl/dev'
 *
 *  const once = optimize(MODULE)                 // one sweep of DEFAULT_PASSES
 *  const cseOnly = optimize(MODULE, [cse])       // isolate a single pass to measure it
 *  ```
 */
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

/** Optimize ONE function to a fixed point (#1186). Reuses the module-level passes
 *  by wrapping the function in a one-function module — every DEFAULT_PASSES pass
 *  is `{ ...m, funcs: m.funcs.map(perFnFn) }` with a `(f: FuncDecl) => FuncDecl`
 *  transform, so it reads ONLY the function it maps; the shell's consts/structs/
 *  bindings are inert (carried via `{ ...m }` only so a defensive `...m` spread
 *  inside a pass sees a well-formed module).
 *
 *  ⚠ INVARIANT: this is correct ONLY while every pass is per-function-pure. A
 *  CROSS-function pass (inline, deadFnElim — both deliberately UNWIRED, see
 *  DEFAULT_PASSES) run on a one-function module would see a different module than
 *  the whole and silently diverge. `fixpoint-ireq.test.ts` pins per-function ≡
 *  whole-module on the real projection module so wiring such a pass fails loudly.
 *  (`gvn` was listed here too until #1865 wired it. It never belonged: `gvn(m)` is
 *  `m.funcs.map(gvnFn)` and `gvnFn(f: FuncDecl)` reads NOTHING outside the function
 *  it maps — the same shape as every other pass in the list.) */
function fnFixpoint(
  fn: FuncDecl,
  m: ModuleDecl,
  passes: readonly OptPass[],
  maxIters: number,
): FuncDecl {
  let cur = fn
  for (let i = 0; i < maxIters; i++) {
    const next = optimize({ ...m, funcs: [cur] }, passes).funcs[0]!
    if (irEqual(next, cur)) return next
    cur = next
  }
  return cur
}

/** Run `passes` to a fixed point — until each function stops changing — capped at
 *  `maxIters`. Functions are optimized INDEPENDENTLY (see `fnFixpoint`): because
 *  every pass is per-function, a function reaches the same fixed point whether it
 *  is optimized alone or inside the whole module, and each one stops at its OWN
 *  convergence instead of being re-swept until the slowest function in the module
 *  settles — the merged multi-projection shaders carry ~38 functions of very
 *  uneven depth, so the whole-module loop wasted most sweeps re-running the ones
 *  that had already converged (#1186).
 *
 *  Convergence is tested by `irEqual`, a short-circuiting structural walk that
 *  replaced a whole-module `JSON.stringify` compare (188 MB across a demo's
 *  pipeline compiles — #1186); it bails at the first differing node and allocates
 *  nothing. */
export function fixpoint(
  m: ModuleDecl,
  passes: readonly OptPass[] = DEFAULT_PASSES,
  maxIters = 8,
): ModuleDecl {
  return { ...m, funcs: m.funcs.map((fn) => fnFixpoint(fn, m, passes, maxIters)) }
}

// ── Named optimization levels (C-compiler -O0/-O1/-O2) ──
// emit hardcodes the full pipeline (`be.optimize = fixpoint(m)` = O2). These named
// tiers expose the intermediate points so a consumer can emit a debug build (O0,
// naive — every author-written subexpr verbatim) or a bit-exact build (O1) and, in
// particular, so the measurement util can A/B the optimizer's effect (O0 vs O2).
/** A named optimization tier, in the C-compiler spelling. The line that matters to a caller is
 *  between O1 and O2, and it is not about how hard the optimizer tries:
 *
 *  - `'O0'` — nothing. Naive lowered emit; the size baseline the optimizer is measured against.
 *  - `'O1'` — the bit-exact value-MOVERS only. None of them changes WHICH float ops execute, so
 *    an O1 build's runtime values are bit-identical to O0's on every target.
 *  - `'O2'` — the full pipeline, and the emit default. Adds const-folding on floats, algebraic
 *    identities and LICM — passes that CAN move float semantics, which is why they sit behind
 *    the real-GPU f32 differential gate rather than being on at O1.
 *
 *  So O0→O1 is free of numerical risk and O1→O2 is not. Pick O1 when a build must be provably
 *  value-identical to the unoptimized one; O2 otherwise. See `LEVEL_PASSES` for the exact list
 *  each tier runs and `optimizeAt` to apply one.
 *
 *  Exported from `@xgis/shader-dsl/dev`.
 */
export type OptLevel = 'O0' | 'O1' | 'O2'

/** The pass list each level runs to a fixed point.
 *  • O0 — none. Naive lowered emit (debug / the size baseline the optimizer is measured against).
 *  • O1 — the bit-exact value-MOVERS + cleanup only: const/copy-prop, dead-branch, cse, cse-local,
 *    gvn, dce. None changes WHICH float ops execute, so O1's RUNTIME VALUES are bit-identical to O0
 *    on every target. (the CSE family may rewrite the SOURCE — hoist a repeat to a `let` — but never
 *    the result; that source-vs-result split is exactly what measure.ts's "bytes ≠ work" surfaces.) It
 *    deliberately omits const-FOLD on floats, algebraic identities, and LICM — the passes that can
 *    change float semantics and so need the real-GPU f32 differential gate (P3).
 *  • O2 — the full DEFAULT_PASSES (adds constFold + algebraicSimplify + licm). The emit default;
 *    `optimizeAt(m,'O2')` is identical to every backend's `optimize: (m) => fixpoint(m)`. */
export const LEVEL_PASSES: Record<OptLevel, readonly OptPass[]> = {
  O0: [],
  O1: [constProp, copyProp, deadBranch, structCtor, cse, cseLocal, gvn, dce],
  O2: DEFAULT_PASSES,
}

/** Optimize a module at a named level (fixpoint of that level's passes). O0 is identity. */
export function optimizeAt(m: ModuleDecl, level: OptLevel): ModuleDecl {
  return level === 'O0' ? m : fixpoint(m, LEVEL_PASSES[level])
}
