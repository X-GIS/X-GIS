// ═══ AST → WGSL Expression Compiler ═══
// Translates per-feature-gpu expressions into shader-dsl IR Nodes, then emits
// the WGSL string through the package emitter (`nodeToWgslString` → `emitExpr`).
// Only handles GPU-safe expressions (arithmetic, builtins, field access).
//
// Authored as IR (NOT hand-assembled WGSL strings) so the single neutral
// tree-walk owns spelling: control-flow / operator parenthesisation, the
// intrinsic-name registry, and literal formatting live in `@xgis/shader-dsl`,
// not in a parallel string builder here. `astToNode` is the reusable Node
// surface; `exprToWGSL` is the back-compat string wrapper for callers that
// still consume WGSL text. Emitted WGSL is semantically identical to the prior
// hand-built strings (the IR emitter adds redundant parentheses around binops /
// comparisons, which never change WGSL evaluation).

import type * as AST from '../parser/ast'
import type { NodeLike } from './node-types'
import { nodeToWgslString } from './node-to-wgsl'
import {
  f32Lit,
  featDataField,
  negF32,
  callF32,
  maxF32,
  compareToBool,
  selectF32,
  binaryVerbatimF32,
  f32Add,
  f32Sub,
  f32Mul,
  f32Div,
  f32Mod,
} from './_util/node-builders'

/** GPU-safe builtin allowlist. Every name maps to the IDENTITY WGSL spelling
 *  (`name(args)`), so the package backend's intrinsic registry — not a local
 *  name→name table — owns the spelling. This Set is only the compiler-side
 *  SEMANTIC gate deciding which calls are permitted on the GPU expression path;
 *  unknown names fall through to user-fn inlining or the `0.0` default. */
const WGSL_BUILTIN_FNS: ReadonlySet<string> = new Set([
  'clamp',
  'min',
  'max',
  'round',
  'floor',
  'ceil',
  'abs',
  'sqrt',
  'log',
  'log2',
  'exp',
  'exp2',
  'pow',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
])

/**
 * Compile an AST expression to a shader-dsl IR Node (typed f32 — every value on
 * this path is f32; strings/colors collapse to `0.0`). Field access resolves to
 * the `feat_data[input.feat_id * STRIDE + offset]` lookup Node.
 * @param expr The AST expression
 * @param fieldMap Maps field names to their offset in the feature data buffer
 */
export function astToNode(expr: AST.Expr, fieldMap: Map<string, number>): NodeLike<'f32'> {
  switch (expr.kind) {
    case 'NumberLiteral':
      return f32Lit(expr.value)

    case 'StringLiteral':
      // Strings can't exist in WGSL fragment shaders
      return f32Lit(0)

    case 'ColorLiteral':
      return f32Lit(0) // Colors should be handled at IR level, not expression level

    case 'BoolLiteral':
      return f32Lit(expr.value ? 1 : 0)

    case 'Identifier':
      return featDataField(expr.name, fieldMap) ?? f32Lit(0)

    case 'FieldAccess':
      return featDataField(expr.field, fieldMap) ?? f32Lit(0)

    case 'BinaryExpr': {
      const left = astToNode(expr.left, fieldMap)
      const right = astToNode(expr.right, fieldMap)
      switch (expr.op) {
        case '+':
          return f32Add(left, right)
        case '-':
          return f32Sub(left, right)
        case '*':
          return f32Mul(left, right)
        case '/':
          return f32Div(left, right)
        case '%':
          return f32Mod(left, right)
        // Comparison ops return bool → bridge to f32 via select(0, 1, cond)
        case '==':
        case '!=':
        case '<':
        case '>':
        case '<=':
        case '>=':
          return selectF32(f32Lit(0), f32Lit(1), compareToBool(left, expr.op, right))
        case '&&':
          return f32Mul(left, right) // both non-zero = truthy
        case '||':
          return maxF32(left, right)
        default:
          // verbatim `(a op b)` — matches the legacy string default arm
          return binaryVerbatimF32(left, expr.op, right)
      }
    }

    case 'UnaryExpr': {
      const operand = astToNode(expr.operand, fieldMap)
      if (expr.op === '-') return negF32(operand)
      if (expr.op === '!') return f32Sub(f32Lit(1), operand)
      return operand
    }

    case 'FnCall':
      return fnCallToNode(expr, fieldMap)

    case 'ConditionalExpr': {
      const cond = astToNode(expr.condition, fieldMap)
      const thenVal = astToNode(expr.thenExpr, fieldMap)
      const elseVal = astToNode(expr.elseExpr, fieldMap)
      return selectF32(elseVal, thenVal, compareToBool(cond, '!=', f32Lit(0)))
    }

    default:
      return f32Lit(0)
  }
}

/**
 * Compile an AST expression to a WGSL expression string. Back-compat wrapper
 * around `astToNode` for callers that consume WGSL text; the string is produced
 * by the package emitter, not assembled here.
 */
export function exprToWGSL(expr: AST.Expr, fieldMap: Map<string, number>): string {
  return nodeToWgslString(astToNode(expr, fieldMap))
}

function fnCallToNode(expr: AST.FnCall, fieldMap: Map<string, number>): NodeLike<'f32'> {
  const name = expr.callee.kind === 'Identifier' ? expr.callee.name : null
  if (!name) return f32Lit(0)

  const args = expr.args.map((a) => astToNode(a, fieldMap))

  // Special cases
  if (name === 'scale') {
    return f32Mul(args[0] ?? f32Lit(0), args[1] ?? f32Lit(1))
  }
  if (name === 'step') {
    // step(value, threshold, below, above)
    return selectF32(
      args[3] ?? f32Lit(1),
      args[2] ?? f32Lit(0),
      compareToBool(args[0] ?? f32Lit(0), '<', args[1] ?? f32Lit(0)),
    )
  }
  if (name === 'log10') {
    return f32Div(
      callF32('log', [maxF32(args[0] ?? f32Lit(0), f32Lit(1e-10))]),
      callF32('log', [f32Lit(10)]),
    )
  }

  // WGSL built-in
  if (WGSL_BUILTIN_FNS.has(name)) {
    return callF32(name, args)
  }

  return f32Lit(0)
}

/**
 * Collect all field names referenced in an expression.
 * Used to build the fieldMap for storage buffer layout.
 */
export function collectFields(expr: AST.Expr): Set<string> {
  const fields = new Set<string>()
  walkExpr(expr, fields)
  return fields
}

function walkExpr(expr: AST.Expr, fields: Set<string>): void {
  switch (expr.kind) {
    case 'Identifier':
      if (expr.name !== 'zoom') fields.add(expr.name)
      break
    case 'FieldAccess':
      fields.add(expr.field)
      if (expr.object) walkExpr(expr.object, fields)
      break
    case 'BinaryExpr':
      walkExpr(expr.left, fields)
      walkExpr(expr.right, fields)
      break
    case 'UnaryExpr':
      walkExpr(expr.operand, fields)
      break
    case 'FnCall':
      expr.args.forEach((a) => walkExpr(a, fields))
      break
  }
}

/**
 * Conservative field-name collector for runtime label/icon field-filter.
 *
 * Returns the Set of feature-property field names the expression reads,
 * OR null if the expression contains ANY node kind this function does not
 * fully traverse — ConditionalExpr, MatchBlock arms, ArrayLiteral,
 * ArrayAccess, or anything unrecognised. A null result tells the caller
 * "we can't guarantee completeness; fall back to full props" so labels
 * and icons never silently lose a field they reference.
 *
 * PAINT-SAFE: this function is INDEPENDENT of collectFields/walkExpr.
 * Do NOT change collectFields or walkExpr — the GPU feature-buffer layout
 * depends on them and the variant drift gate checks their output. This
 * function is exclusively for the runtime worker featureProps filter path.
 *
 * Node coverage (complete — returns Set):
 *   NumberLiteral / StringLiteral / ColorLiteral / BoolLiteral — no fields
 *   Identifier — adds name (except reserved 'zoom')
 *   FieldAccess — adds field, recurses into object
 *   BinaryExpr — recurses left + right
 *   UnaryExpr — recurses operand
 *   FnCall — recurses args + matchBlock arms (key+value both)
 *   MatchBlock — recurses all arm values
 *   ArrayLiteral — recurses all elements
 *   ArrayAccess — recurses array + index
 *   ConditionalExpr — recurses condition + thenExpr + elseExpr
 *
 * Returns null immediately on any unrecognised kind (defensive).
 */
export function collectFieldsStrict(expr: AST.Expr): Set<string> | null {
  const fields = new Set<string>()
  return walkStrict(expr, fields) ? fields : null
}

/** Returns false if it encounters any unrecognised node kind. */
function walkStrict(expr: AST.Expr, fields: Set<string>): boolean {
  switch (expr.kind) {
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'ColorLiteral':
    case 'BoolLiteral':
      return true
    case 'Identifier':
      // 'zoom' is the camera builtin; null/true/false are keyword literals
      // (the grammar has no Null/Bool-as-Identifier node) — none is a field.
      if (
        expr.name !== 'zoom' &&
        expr.name !== 'null' &&
        expr.name !== 'true' &&
        expr.name !== 'false'
      )
        fields.add(expr.name)
      return true
    case 'FieldAccess':
      fields.add(expr.field)
      return expr.object === null || walkStrict(expr.object, fields)
    case 'BinaryExpr':
      return walkStrict(expr.left, fields) && walkStrict(expr.right, fields)
    case 'UnaryExpr':
      return walkStrict(expr.operand, fields)
    case 'FnCall': {
      // get("field") is an evaluator builtin (eval/evaluator.ts:260) that reads
      // a feature property BY NAME — the converter emits this form for colon-
      // bearing keys (e.g. name:latin / name:nonlatin) that the `.field`
      // FieldAccess syntax cannot lex. The key lives in a StringLiteral arg,
      // NOT a FieldAccess, so the generic arg-recursion below would miss it,
      // silently dropping the field from the per-slice featureProps filter
      // (broke OFM Bright non-latin labels, #375 follow-up). `has` is handled
      // defensively: the converter lowers has(...) to `.field != null` /
      // get(...) != null today, but a direct has("k") reads the same key.
      if (
        expr.callee.kind === 'Identifier' &&
        (expr.callee.name === 'get' || expr.callee.name === 'has')
      ) {
        const a0 = expr.args[0]
        if (a0 && a0.kind === 'StringLiteral') {
          fields.add(a0.value)
          return true
        }
        // Dynamic key (e.g. get(concat("name:", get("lang")))) — the accessed
        // field is unknowable statically; bail so the slice keeps full props.
        return false
      }
      for (const a of expr.args) {
        if (!walkStrict(a, fields)) return false
      }
      if (expr.matchBlock) {
        if (!walkStrict(expr.matchBlock, fields)) return false
      }
      return true
    }
    case 'MatchBlock': {
      for (const arm of expr.arms) {
        if (!walkStrict(arm.value, fields)) return false
      }
      return true
    }
    case 'ArrayLiteral': {
      for (const el of expr.elements) {
        if (!walkStrict(el, fields)) return false
      }
      return true
    }
    case 'ArrayAccess':
      return walkStrict(expr.array, fields) && walkStrict(expr.index, fields)
    case 'ConditionalExpr':
      return (
        walkStrict(expr.condition, fields) &&
        walkStrict(expr.thenExpr, fields) &&
        walkStrict(expr.elseExpr, fields)
      )
    default:
      // Unrecognised node kind — bail conservatively.
      return false
  }
}
