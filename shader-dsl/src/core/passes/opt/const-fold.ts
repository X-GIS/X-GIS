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

import type { Expr, ModuleDecl } from '../../ir'
import { boolT } from '../../ir'
import { mapModuleExprs } from './ir-transform'

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
        v = undefined // % / & | ^ << >> — not folded
    }
    if (v !== undefined) return { op: 'lit', type: e.type, value: v }
  }
  if (e.op === 'unop' && e.a.op === 'lit' && typeof e.a.value === 'number') {
    return { op: 'lit', type: e.type, value: -e.a.value }
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
