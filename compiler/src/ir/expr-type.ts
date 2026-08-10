// ═══ Expression value typing — the vector half (#1537) ═══
//
// The language's binding positions (`size-[…]`, `opacity-[…]`, `stroke-[…]`)
// are all SCALAR: a data-driven binding resolves to one number per feature.
// Vector values (#1537) exist to feed component reads and, next, shader stage
// blocks (#1538) — so a vector reaching a scalar binding is an authoring
// error, and one that must be LOUD: on the CPU path it would set a size to an
// array, on the GPU path it would compile a wrong-typed expression.
//
// This module answers exactly one question — "is this expression definitely
// vector-valued, and of what arity?" — and nothing else. A deliberately
// NARROW judgement: `null` means "not provably a vector", so every
// pre-#1537 expression keeps its meaning and the gate below is
// false-positive-free by construction.

import type * as AST from '../parser/ast'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { VECTOR_IN_SCALAR_POSITION, STAGE_RETURN_TYPE } from '../diagnostics/diagnostic'
import { VEC_COMPONENT_INDEX } from '../eval/evaluator-helpers'

/** Lane count of the vec constructors, keyed by callee name. */
const VEC_ARITY: ReadonlyMap<string, 2 | 3 | 4> = new Map([
  ['vec2', 2],
  ['vec3', 3],
  ['vec4', 4],
])

/**
 * The vector arity of `expr`, or `null` when it is not provably a vector.
 *
 * Rules (WGSL-shaped):
 *   • `vecN(…)` is a vector of arity N;
 *   • arithmetic with a vector operand stays that vector (component-wise —
 *     `vec3(…) * 2` is a vec3), and two vectors must agree;
 *   • a component read (`.x` / `.r` / …) is scalar again;
 *   • a conditional is a vector only when BOTH branches agree;
 *   • everything else is scalar-or-unknown → `null`.
 */
export function inferVecArity(expr: AST.Expr): 2 | 3 | 4 | null {
  switch (expr.kind) {
    case 'FnCall':
      return expr.callee.kind === 'Identifier' ? (VEC_ARITY.get(expr.callee.name) ?? null) : null
    case 'InputRef':
      // A `color`-typed input (#1539) IS a vec4 value — reusing this
      // authority means the EXISTING X-GIS0018 (vector in scalar
      // position) check automatically rejects `opacity-[highlight]`
      // without a new diagnostic code, and stage blocks (X-GIS0020) can
      // return a bare color input directly (`@color { return highlight }`).
      return expr.type === 'color' ? 4 : null
    case 'FieldAccess':
      // An explicit-object component read collapses a vector to a lane.
      // (The object-less form is feature-property access — scalar.)
      return null
    case 'BinaryExpr': {
      const l = inferVecArity(expr.left)
      const r = inferVecArity(expr.right)
      if (l !== null && r !== null) return l === r ? l : null
      return l ?? r
    }
    case 'UnaryExpr':
      return inferVecArity(expr.operand)
    case 'ConditionalExpr': {
      const t = inferVecArity(expr.thenExpr)
      return t !== null && t === inferVecArity(expr.elseExpr) ? t : null
    }
    default:
      return null
  }
}

/** Is `field` one of the vector component accessors? Shared with the
 *  evaluator's lane table so both paths read the same authority. */
export function isVecComponent(field: string): boolean {
  return VEC_COMPONENT_INDEX.has(field)
}

/**
 * Reject vector values in scalar binding positions (`X-GIS0018`). Runs over
 * the whole program after user-fn inlining, so a vector arriving through an
 * inlined `fn` body is caught at the binding that used it.
 */
export function validateBindingTypes(program: AST.Program, diagnostics: Diagnostic[]): void {
  const checkLines = (lines: readonly AST.UtilityLine[]): void => {
    for (const line of lines) {
      for (const item of line.items) {
        if (!item.binding) continue
        const arity = inferVecArity(item.binding)
        if (arity === null) continue
        diagnostics.push({
          code: VECTOR_IN_SCALAR_POSITION,
          severity: 'error',
          span: { line: line.line, col: 1 },
          message:
            `Utility \`${item.name}\` binds a vec${arity} value, but a binding ` +
            `resolves to one number per feature.`,
          help: `Read a lane (e.g. \`${item.name}-[expr.x]\`) or bind a scalar expression.`,
        })
      }
    }
  }

  for (const s of program.body) {
    switch (s.kind) {
      case 'LayerStatement':
        checkLines(s.utilities)
        // #1538 — the mirror rule for stage blocks: the variant colour slot
        // is vec4, so a body of any other type would compile a wrong-typed
        // shader expression. Rejected here, never coerced.
        for (const st of s.stages ?? []) {
          if (inferVecArity(st.body) === 4) continue
          diagnostics.push({
            code: STAGE_RETURN_TYPE,
            severity: 'error',
            span: { line: st.line, col: 1 },
            message: `Stage block \`@${st.stage}\` must return a vec4 colour.`,
            help: `Wrap the result, e.g. \`return vec4(r, g, b, 1)\`.`,
          })
        }
        break
      case 'PresetStatement':
      case 'BackgroundStatement':
        checkLines(s.utilities)
        break
      case 'KeyframesStatement':
        for (const f of s.frames) {
          checkLines([{ kind: 'UtilityLine', items: f.utilities, line: f.line }])
        }
        break
    }
  }
}
