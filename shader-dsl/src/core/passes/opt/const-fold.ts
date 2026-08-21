// ═══ Shader DSL — constant folding pass (Optimization context) ═══
//
// Collapses literal-operand scalar arithmetic to a single literal. Runs
// bottom-up (via mapModuleExprs), so a nested literal tree folds in one pass.
//
// PRECISION: folds in f64, matching the CPU oracle — so oracle value-equality
// (the P2 correctness gate) holds EXACTLY. GPU-f32-precise folding (fround each
// step, to match the runtime f32 result bit-for-bit) is deferred to P3, when the
// real-GPU f32 differential exists to verify it. Only the IEEE-deterministic ops
// (+ - *) are folded; / is folded only when the divisor is non-zero; %, bitwise
// and shifts are left alone (semantics/precision care).
//
// Also folds literal CONTROL predicates (constexpr conditions): a `compare` of two
// number literals → a bool literal (mirroring the oracle's f32 `==`/`!=` fround
// rule so fold == oracle exactly), a `logical` of two bool literals, and a
// `select` whose cond folded to a bool literal → the chosen branch. These expose
// the dead branches that dead-branch.ts then removes.

import type { Expr, ModuleDecl, BinOp } from '../../ir/index.js'
import { boolT } from '../../ir/index.js'
import { mapModuleExprs } from './ir-transform.js'
import { intElemOf, wrapInt } from './expr-utils.js'

/** Fold two INTEGER literals with the target's semantics, not JavaScript's.
 *
 *  This arm exists because the float arm below is wrong for integers in three separate
 *  ways, each measured against gcc 13.3 -O2 and each reachable once const-prop has
 *  substituted two known constants:
 *    • DIVISION TRUNCATES. `i32 7 / 2` is 3, not 3.5 — and a fractional value carried in
 *      an i32-typed `lit` emits as the literal `3.5`, which is not an i32 at all. The u32
 *      spelling `3.5u` is not even WGSL grammar.
 *    • ARITHMETIC WRAPS. `i32 2147483647 + 1` is -2147483648 and `i32 100000 * 100000` is
 *      1410065408; folding in f64 kept 2147483648 and 10000000000, values the type cannot
 *      hold.
 *    • u32 IS UNSIGNED. `u32 0 - 1` is 4294967295. Folding in f64 produced `-1`, emitted
 *      as `-1u` — again not WGSL grammar, and a compile error rather than a wrong pixel.
 *  `%`, `&`, `|`, `^`, `<<`, `>>` were previously left unfolded entirely; they are folded
 *  here because on integers they are exactly as well-defined as `+`. Multiplication goes
 *  through `Math.imul`, which is the wrapping 32-bit product — `a * b` in f64 loses bits
 *  above 2^53 and would wrap the WRONG value. */
function foldIntLit(bop: BinOp, a: number, b: number, elem: 'i32' | 'u32'): number | undefined {
  const ua = elem === 'u32' ? a >>> 0 : a | 0
  const ub = elem === 'u32' ? b >>> 0 : b | 0
  switch (bop) {
    case '+':
      return wrapInt(ua + ub, elem)
    case '-':
      return wrapInt(ua - ub, elem)
    case '*':
      return wrapInt(Math.imul(ua, ub), elem)
    case '/':
      // Truncating division (C99 / WGSL). i32 INT_MIN / -1 overflows; wrapInt gives
      // INT_MIN back, which is what the hardware produces.
      return ub === 0 ? undefined : wrapInt(Math.trunc(ua / ub), elem)
    case '%':
      // JS `%` truncates toward zero, same as C and WGSL: -7 % 2 === -1.
      return ub === 0 ? undefined : wrapInt(ua % ub, elem)
    case '&':
      return wrapInt(ua & ub, elem)
    case '|':
      return wrapInt(ua | ub, elem)
    case '^':
      return wrapInt(ua ^ ub, elem)
    // A shift count outside [0, 31] is not folded: JS masks it to 5 bits, and leaning on
    // that would bake one interpretation of a case the targets do not agree on.
    case '<<':
      return ub < 0 || ub > 31 ? undefined : wrapInt(ua << ub, elem)
    case '>>':
      return ub < 0 || ub > 31 ? undefined : wrapInt(elem === 'u32' ? ua >>> ub : ua >> ub, elem)
    default:
      return undefined
  }
}

function foldNode(e: Expr): Expr {
  if (
    e.op === 'binop' &&
    e.a.op === 'lit' &&
    e.b.op === 'lit' &&
    typeof e.a.value === 'number' &&
    typeof e.b.value === 'number'
  ) {
    const a = e.a.value,
      b = e.b.value
    const int = intElemOf(e.type)
    if (int !== undefined) {
      const iv = foldIntLit(e.bop, a, b, int)
      return iv === undefined ? e : { op: 'lit', type: e.type, value: iv }
    }
    let v: number | undefined
    switch (e.bop) {
      case '+':
        v = a + b
        break
      case '-':
        v = a - b
        break
      case '*':
        v = a * b
        break
      case '/':
        v = b !== 0 ? a / b : undefined
        break
      default:
        v = undefined // % / & | ^ << >> — float: left alone (see foldIntLit for integers)
    }
    if (v !== undefined) return { op: 'lit', type: e.type, value: v }
  }
  if (e.op === 'unop' && e.a.op === 'lit' && typeof e.a.value === 'number') {
    const int = intElemOf(e.type)
    // -INT_MIN wraps back to INT_MIN, and -(u32) is the two's-complement negation.
    return {
      op: 'lit',
      type: e.type,
      value: int === undefined ? -e.a.value : wrapInt(-e.a.value, int),
    }
  }
  // compare(lit, lit) -> bool lit. == / != fround f32 operands (matching the
  // oracle, oracle.ts:208); ordering stays f64 (the stricter mirror for thresholds).
  if (
    e.op === 'compare' &&
    e.a.op === 'lit' &&
    e.b.op === 'lit' &&
    typeof e.a.value === 'number' &&
    typeof e.b.value === 'number'
  ) {
    const f32 = e.a.type.kind === 'scalar' && e.a.type.scalar === 'f32'
    const a = e.a.value,
      b = e.b.value
    let v: boolean
    switch (e.cop) {
      case '<':
        v = a < b
        break
      case '>':
        v = a > b
        break
      case '<=':
        v = a <= b
        break
      case '>=':
        v = a >= b
        break
      case '==':
        v = f32 ? Math.fround(a) === Math.fround(b) : a === b
        break
      case '!=':
        v = f32 ? Math.fround(a) !== Math.fround(b) : a !== b
        break
    }
    return { op: 'lit', type: boolT, value: v }
  }
  // logical(lit bool, lit bool) -> bool lit. Both operands are literals here, so
  // there is nothing to short-circuit.
  if (
    e.op === 'logical' &&
    e.a.op === 'lit' &&
    e.b.op === 'lit' &&
    typeof e.a.value === 'boolean' &&
    typeof e.b.value === 'boolean'
  ) {
    const v = e.lop === '&&' ? e.a.value && e.b.value : e.a.value || e.b.value
    return { op: 'lit', type: boolT, value: v }
  }
  // select(lit cond, t, f) -> t | f (the dead arm is dropped).
  if (e.op === 'select' && e.cond.op === 'lit' && typeof e.cond.value === 'boolean') {
    return e.cond.value ? e.ifTrue : e.ifFalse
  }
  return e
}

/** Fold literal-operand arithmetic throughout a module. Pure (module -> module).
 *  Raw-Stmt fns are skipped (#763 P1) — f64 pre-folding around a raw splice
 *  double-rounds vs the GPU's stepwise f32. */
export function constFold(m: ModuleDecl): ModuleDecl {
  return mapModuleExprs(m, foldNode, { skipRawBodies: true })
}
