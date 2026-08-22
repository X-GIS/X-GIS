// ═══ Shader DSL — algebraic simplification pass (Optimization context) ═══
//
// The identity rewrites, held to gcc -O2's line: everything here is what gcc folds
// WITHOUT `-ffast-math`, and nothing here is what it needs that flag for. That line is
// not a style choice — `-ffast-math`'s reassociation and distribution are exactly what
// deletes an emulated-double error term (see core/fp64/df64-lib.ts), so the rewrites gcc
// gates behind it are the ones this codebase can least afford.
//
// FLOAT — only the rewrites that hold for every value, NaN and Inf included:
//   x*1, 1*x, x/1, x+0, 0+x, x-0            (x+0 is a DELIBERATE deviation, see below)
//   -(-x) -> x                              sign flip twice, exact
//   x - (-y) -> x + y                       exact; gcc -O2 does this
//   x / 2^k -> x * 2^-k                     both are correctly-rounded scalings by a power
//                                           of two, so bit-identical; gcc -O2 does this,
//                                           and a GPU divide costs several multiplies
//   select(c, x, x) -> x                    c is pure, so dropping it is unobservable
//
// NOT applied on floats, matching gcc without -ffast-math: `x*0 -> 0` and `x-x -> 0` (both
// NaN/Inf-unsound), and any reassociation or distribution.
//
// THE ONE PLACE THIS IS MORE AGGRESSIVE THAN gcc: `x + 0 -> x`. Measured, gcc -O2 KEEPS
// that add and only folds it under -ffast-math, because `(-0.0) + 0.0` is `+0.0` — the
// rewrite is observable through a signed zero. It predates this pass's gcc alignment and
// is kept deliberately (the file's original note: shader math does not traffic in −0), but
// it is the one rule here that a fast-math flag should own rather than the default path.
//
// INTEGER — sound on i32/u32 and NOT on floats, hence gated on `intElemOf`:
//   i*0, 0*i, i&0, 0&i, i%1 -> 0            i|0, 0|i, i^0, 0^i, i<<0, i>>0 -> i
//   i-i, i^i -> 0                           i&i, i|i -> i
// Self-identity uses `keyOf` (the CSE/GVN structural key, so the three cannot disagree
// about what "the same expression" is). Shader expressions are pure, so collapsing two
// structurally identical operands cannot drop an effect.

import type { Expr, ModuleDecl, ShaderType } from '../../ir/index.js'
import { mapModuleExprs } from './ir-transform.js'
import { intElemOf, keyOf } from './expr-utils.js'

const isLit = (e: Expr, v: number): boolean =>
  e.op === 'lit' && typeof e.value === 'number' && e.value === v

const same = (a: Expr, b: Expr): boolean => keyOf(a) === keyOf(b)

const zeroOf = (t: ShaderType): Expr => ({ op: 'lit', type: t, value: 0 })

/** True for a native f32 scalar / vector — the only types the reciprocal rewrite may touch.
 *  `f64T` is its own kind and is NOT matched: an emulated double divides through the df64
 *  library, where a "multiply by the reciprocal instead" is a different algorithm. */
const isF32ish = (t: ShaderType): boolean =>
  (t.kind === 'scalar' && t.scalar === 'f32') || (t.kind === 'vec' && t.elem === 'f32')

/** `1/c` when `c` is a literal power of two whose reciprocal is exact and stays f32-normal,
 *  else undefined. The bound is |k| <= 126 so neither `c` nor `1/c` reaches a subnormal or
 *  an overflow, where the two spellings could stop agreeing. */
function exactReciprocal(e: Expr): number | undefined {
  if (e.op !== 'lit' || typeof e.value !== 'number' || !isF32ish(e.type)) return undefined
  const c = e.value
  if (!Number.isFinite(c) || c === 0) return undefined
  const k = Math.log2(Math.abs(c))
  if (!Number.isInteger(k) || Math.abs(k) > 126) return undefined
  return 1 / c
}

function simplifyNode(e: Expr): Expr {
  // -(-x) -> x
  if (e.op === 'unop' && e.a.op === 'unop') return e.a.a
  // select(c, x, x) -> x
  if (e.op === 'select' && same(e.ifTrue, e.ifFalse)) return e.ifTrue
  if (e.op !== 'binop') return e

  const int = intElemOf(e.type)
  switch (e.bop) {
    case '+':
      if (isLit(e.b, 0)) return e.a
      if (isLit(e.a, 0)) return e.b
      break
    case '-':
      if (isLit(e.b, 0)) return e.a // x - 0 -> x (NOT 0 - x)
      if (e.b.op === 'unop') return { op: 'binop', type: e.type, bop: '+', a: e.a, b: e.b.a }
      if (int !== undefined && same(e.a, e.b)) return zeroOf(e.type)
      break
    case '*':
      if (isLit(e.b, 1)) return e.a
      if (isLit(e.a, 1)) return e.b
      if (int !== undefined && (isLit(e.b, 0) || isLit(e.a, 0))) return zeroOf(e.type)
      break
    case '/': {
      if (isLit(e.b, 1)) return e.a // x / 1 -> x (NOT 1 / x)
      if (int !== undefined) break // integer division is not a scaling
      const r = exactReciprocal(e.b)
      if (r !== undefined) {
        const recip: Expr = { op: 'lit', type: e.b.type, value: r }
        return { op: 'binop', type: e.type, bop: '*', a: e.a, b: recip }
      }
      break
    }
    case '%':
      if (int !== undefined && isLit(e.b, 1)) return zeroOf(e.type)
      break
    case '&':
      if (int === undefined) break
      if (isLit(e.b, 0) || isLit(e.a, 0)) return zeroOf(e.type)
      if (same(e.a, e.b)) return e.a
      break
    case '|':
      if (int === undefined) break
      if (isLit(e.b, 0)) return e.a
      if (isLit(e.a, 0)) return e.b
      if (same(e.a, e.b)) return e.a
      break
    case '^':
      if (int === undefined) break
      if (isLit(e.b, 0)) return e.a
      if (isLit(e.a, 0)) return e.b
      if (same(e.a, e.b)) return zeroOf(e.type)
      break
    case '<<':
    case '>>':
      if (int !== undefined && isLit(e.b, 0)) return e.a
      break
  }
  return e
}

/** Apply the sound algebraic identities throughout a module. Pure (module -> module).
 *  Raw-Stmt fns are skipped (#763 P1) — identity rewrites must not touch authored
 *  arithmetic around a verbatim raw splice. */
export function algebraicSimplify(m: ModuleDecl): ModuleDecl {
  return mapModuleExprs(m, simplifyNode, { skipRawBodies: true })
}
