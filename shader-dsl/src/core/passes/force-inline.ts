// ═══ Shader DSL — FORCED inlining: unlock `opaque` and remove the helper ═══
//
// `inlineLinearAll` (the shipped `inline()` plugin) honours `FuncDecl.opaque`, so the
// df64 emulation library it protects is never inlined and never removed. Measured on
// the example corpus, that makes inline() a complete NO-OP on all 13 fp64 examples —
// 39 of 39 emitted sources byte-identical across WGSL and both GLSL stages — while
// non-fp64 examples move by −56 B to +9601 B. This pass is the opt-in escape hatch:
// it UNLOCKS that opacity, inlines through it, and tree-shakes the emptied decls, so
// the df64_* functions leave the output entirely.
//
// WHY THAT IS SAFE FOR OUR OWN PASSES. `opaque` protects error-free transformations
// from an optimizer that could algebraically cancel them. Ours cannot: `algebraic.ts`
// rewrites only literal-0/1 operands and `const-fold.ts` only literal-operand binops,
// and every df64 EFT term rides the runtime-opaque `one` guard (a texel fetch), which
// is not a literal. inlineLinearAll's own cleanup is `LEVEL_PASSES.O1` — the bit-exact
// value MOVERS, which by construction cannot change which float ops execute. The
// known-answer gate (force-inline.test.ts) pins that end-to-end under a
// correctly-rounding-f32 oracle rather than leaving it as an argument.
//
// WHY IT IS STILL OPT-IN, AND WHY 'size-win' IS THE DEFAULT. Two costs, both measured:
//   • BYTES. df64 helpers are called from many sites, so 'all' duplicates each body per
//     site: 5.1x to 27.2x on the fp64 corpus (fp64-sine-sweep 6,266 B -> 170,419 B).
//   • DRIVERS. `core/fp64/flavor-select.ts` already records that FXC's compile cost on
//     the FULLY-INLINED df64 bodies can TDR on ANGLE-D3D11. 'all' walks into that.
// 'size-win' unlocks only helpers with exactly ONE call site, where removing the decl
// and its single call is a strict size win and nothing is duplicated — measured −5% to
// +8% bytes for 2-5 fewer functions per example.
//
// INLINING IS NOT FOLDING, AND THAT IS WHY THIS IS SAFE. Flattening a df64 body copies
// its EXPRESSIONS to the call site; it does not evaluate them. The runtime-opaque ONE
// (`f64Guard`, a texel fetch) travels with them, so every error-free-transform term still
// rides the guard after the call is gone — verified on the emitted WGSL, which still reads
// `textureLoad(_fp64, ...)` and still multiplies each EFT term through it. This is C's
// `volatile` rule: inlining a function does not make a volatile expression inside it
// foldable. `force-inline.test.ts` pins it.
//
// WHAT PROTECTS THE RENORM AFTER ITS CALL IS GONE. `renormForCancel` (fp64-lower.ts)
// launders a LOADED lo into a computed one by adding a df64 ZERO ahead of a cancelling
// op, and it is spelled as a df64_ call precisely so the optimizer cannot fold it
// (#915 — Apple sub, Blackwell WebGL2 div). Inlining removes that spelling, so the
// protection has to come from the ADDEND instead.
//
// It now does, BY CONSTRUCTION: the zero is `vec2(optBarrier(0), optBarrier(0))`, a
// bitcast round-trip no fold can see through. It used to be a bare `vec2(0, 0)`, and
// what held then was an ACCIDENT — the zero reached the add as `_cseN.y`, a member of a
// CSE-hoisted let, and no pass folded a member of a construct. `opt/member-fold.ts` is
// now exactly that pass, and it was measured breaking the guard before the barrier
// landed: `_cseN.y` resolves to the literal `0.0`, const-prop carries it into the
// twoSum's `s = a + 0`, and the pre-existing `x + 0 -> x` identity deletes the add. On
// the a/b division kernel that is 408 arithmetic ops -> 400, while the `_fp64` texel
// read SURVIVES (1 -> 1) — so a gate that only checks the guard binding passes straight
// through it. Two things catch it now: the op-count ratchet below, and the cut in
// `opt/member-fold.test.ts` that strips the barrier and requires the drop to reappear.
//
// THIS PASS APPLIES THAT FOLD, and is the only thing that does — it is not in O2. The
// round-trips it removes live inside df64 helper bodies, so the default emit has exactly
// zero of them and wiring it there would perturb every snapshotted byte for nothing. Here
// it fires 2,632 times on the flattened example corpus (31 under 'size-win') and takes it
// from 15,303 arithmetic ops to 14,619 — the single largest remaining gcc -O2 gap, closed
// where it actually exists.
//
// WHAT NEITHER STRENGTH CAN PROMISE. The barrier question this reopens is a DRIVER
// question, and a correctly-rounded CPU oracle (and SwiftShader) is structurally blind
// to it — see the Class-1/Class-2 split in the-multiply-you-cannot-guard. On Apple/Metal
// the integer flavour (`recommendFp64Flavor`) remains the answer; forcing the float
// flavour flat does not change that.

import type { ModuleDecl, Expr } from '../ir/index.js'
import { mapStmt, deadFnElim, memberFold } from './opt/index.js'
import { inlineLinearAll } from './inline-linear.js'

/** How far {@link forceInline} unlocks `FuncDecl.opaque`.
 *  • `'size-win'` — only helpers with exactly ONE call site (no body is duplicated).
 *  • `'all'` — every opaque helper, so the df64 library leaves the output entirely,
 *    at 5-27x the emitted bytes and the ANGLE-D3D11 compile-cost risk noted above. */
export type ForceInlineStrength = 'size-win' | 'all'

/** Call sites of `name` across every fn body in the module. */
function countCalls(m: ModuleDecl, name: string): number {
  let n = 0
  const probe = (e: Expr): Expr => {
    if (e.op === 'call' && e.fn === name) n++
    return e
  }
  for (const f of m.funcs) for (const s of f.body) mapStmt(s, probe)
  return n
}

/** Inline through `opaque`, then drop the functions that inlining emptied. Pure
 *  (module -> module); `@xgis/shader-dsl/emit-prod`'s `forceInline()` plugin.
 *
 *  Opacity is re-applied from a set captured BEFORE the first round, never from a
 *  `df64_` NAME test — a name test is exactly what #1926 removed, because `mangle`
 *  renames the library and the invariant then held or not depending on plugin order. */
export function forceInline(m: ModuleDecl, strength: ForceInlineStrength = 'size-win'): ModuleDecl {
  const locked = new Set(m.funcs.filter((f) => f.opaque === true).map((f) => f.name))
  if (locked.size === 0) return inlineLinearAll(m)

  if (strength === 'all') {
    const opened = { ...m, funcs: m.funcs.map((f) => ({ ...f, opaque: false })) }
    const inlined = inlineLinearAll(opened)
    return inlined === opened ? m : deadFnElim(memberFold(inlined))
  }

  // 'size-win': unlock only the single-call helpers, and re-lock the survivors. Removing
  // one helper can drop another's count to 1, so this repeats until it stops finding any.
  let cur = m
  let moved = false
  for (let round = 0; round <= locked.size; round++) {
    const once = cur.funcs
      .filter((f) => f.opaque === true && countCalls(cur, f.name) === 1)
      .map((f) => f.name)
    if (once.length === 0) break
    const opened = {
      ...cur,
      funcs: cur.funcs.map((f) => (once.includes(f.name) ? { ...f, opaque: false } : f)),
    }
    const inlined = inlineLinearAll(opened)
    if (inlined === opened) break
    moved = true
    cur = {
      ...inlined,
      funcs: inlined.funcs.map((f) => (locked.has(f.name) ? { ...f, opaque: true } : f)),
    }
  }
  // A module whose only inlinable helpers were locked must come back UNCHANGED, so the
  // plugin stays a true no-op there rather than silently re-optimizing (inlineLinearAll's
  // own identity contract, one level up).
  if (!moved) {
    const plain = inlineLinearAll(cur)
    return plain === cur ? m : deadFnElim(memberFold(plain))
  }
  return deadFnElim(memberFold(cur))
}
