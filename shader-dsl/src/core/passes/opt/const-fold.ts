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

import type { Expr, ModuleDecl } from '../../ir'
import { mapModuleExprs } from './ir-transform'

function foldNode(e: Expr): Expr {
  if (
    e.op === 'binop'
    && e.a.op === 'lit' && e.b.op === 'lit'
    && typeof e.a.value === 'number' && typeof e.b.value === 'number'
  ) {
    const a = e.a.value, b = e.b.value
    let v: number | undefined
    switch (e.bop) {
      case '+': v = a + b; break
      case '-': v = a - b; break
      case '*': v = a * b; break
      case '/': v = b !== 0 ? a / b : undefined; break
      default: v = undefined // % / & | ^ << >> — not folded
    }
    if (v !== undefined) return { op: 'lit', type: e.type, value: v }
  }
  if (e.op === 'unop' && e.a.op === 'lit' && typeof e.a.value === 'number') {
    return { op: 'lit', type: e.type, value: -e.a.value }
  }
  return e
}

/** Fold literal-operand arithmetic throughout a module. Pure (module -> module). */
export function constFold(m: ModuleDecl): ModuleDecl {
  return mapModuleExprs(m, foldNode)
}
