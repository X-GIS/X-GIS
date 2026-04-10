// ═══ AST → WGSL Expression Compiler ═══
// Translates per-feature-gpu expressions into WGSL code strings.
// Only handles GPU-safe expressions (arithmetic, builtins, field access).

import type * as AST from '../parser/ast'

/** WGSL built-in function name mapping (most are identical) */
const WGSL_BUILTINS: Record<string, string> = {
  clamp: 'clamp',
  min: 'min',
  max: 'max',
  round: 'round',
  floor: 'floor',
  ceil: 'ceil',
  abs: 'abs',
  sqrt: 'sqrt',
  log: 'log',
  log2: 'log2',
  exp: 'exp',
  exp2: 'exp2',
  pow: 'pow',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  asin: 'asin',
  acos: 'acos',
  atan: 'atan',
  atan2: 'atan2',
}

/** User-defined function environment for inlining */
export type WGSLFnEnv = Map<string, AST.FnStatement>

/**
 * Compile an AST expression to a WGSL expression string.
 * Field access uses `feat_data[feat_idx + OFFSET]` pattern.
 * @param expr The AST expression
 * @param fieldMap Maps field names to their offset in the feature data buffer
 * @param fnEnv Optional user-defined functions for inlining
 */
export function exprToWGSL(
  expr: AST.Expr,
  fieldMap: Map<string, number>,
  fnEnv?: WGSLFnEnv,
): string {
  switch (expr.kind) {
    case 'NumberLiteral':
      return formatFloat(expr.value)

    case 'StringLiteral':
      // Strings can't exist in WGSL fragment shaders
      return '0.0'

    case 'ColorLiteral':
      return '0.0' // Colors should be handled at IR level, not expression level

    case 'BoolLiteral':
      return expr.value ? '1.0' : '0.0'

    case 'Identifier': {
      const offset = fieldMap.get(expr.name)
      if (offset !== undefined) {
        return `feat_data[feat_idx + ${offset}u]`
      }
      return '0.0'
    }

    case 'FieldAccess': {
      const fieldName = expr.field
      const offset = fieldMap.get(fieldName)
      if (offset !== undefined) {
        return `feat_data[feat_idx + ${offset}u]`
      }
      return '0.0'
    }

    case 'BinaryExpr': {
      const left = exprToWGSL(expr.left, fieldMap, fnEnv)
      const right = exprToWGSL(expr.right, fieldMap, fnEnv)
      const op = wgslOp(expr.op)
      if (op) {
        return `(${left} ${op} ${right})`
      }
      // Comparison ops that return bool → convert to f32
      switch (expr.op) {
        case '==': return `select(0.0, 1.0, ${left} == ${right})`
        case '!=': return `select(0.0, 1.0, ${left} != ${right})`
        case '<': return `select(0.0, 1.0, ${left} < ${right})`
        case '>': return `select(0.0, 1.0, ${left} > ${right})`
        case '<=': return `select(0.0, 1.0, ${left} <= ${right})`
        case '>=': return `select(0.0, 1.0, ${left} >= ${right})`
        case '&&': return `(${left} * ${right})` // both non-zero = truthy
        case '||': return `max(${left}, ${right})`
        default: return `(${left} ${expr.op} ${right})`
      }
    }

    case 'UnaryExpr': {
      const operand = exprToWGSL(expr.operand, fieldMap, fnEnv)
      if (expr.op === '-') return `(-${operand})`
      if (expr.op === '!') return `(1.0 - ${operand})`
      return operand
    }

    case 'FnCall':
      return fnCallToWGSL(expr, fieldMap, fnEnv)

    case 'PipeExpr':
      return pipeToWGSL(expr, fieldMap, fnEnv)

    default:
      return '0.0'
  }
}

function fnCallToWGSL(expr: AST.FnCall, fieldMap: Map<string, number>, fnEnv?: WGSLFnEnv): string {
  const name = expr.callee.kind === 'Identifier' ? expr.callee.name : null
  if (!name) return '0.0'

  const args = expr.args.map(a => exprToWGSL(a, fieldMap, fnEnv))

  // Special cases
  if (name === 'scale') {
    return `(${args[0] ?? '0.0'} * ${args[1] ?? '1.0'})`
  }
  if (name === 'step') {
    // step(value, threshold, below, above)
    return `select(${args[3] ?? '1.0'}, ${args[2] ?? '0.0'}, ${args[0] ?? '0.0'} < ${args[1] ?? '0.0'})`
  }
  if (name === 'log10') {
    return `(log(max(${args[0] ?? '0.0'}, 1e-10)) / log(10.0))`
  }

  // WGSL built-in
  const wgslName = WGSL_BUILTINS[name]
  if (wgslName) {
    return `${wgslName}(${args.join(', ')})`
  }

  // User-defined function: try inline
  if (fnEnv?.has(name)) {
    return inlineUserFn(fnEnv.get(name)!, args, fieldMap, fnEnv)
  }

  return '0.0'
}

function pipeToWGSL(expr: AST.PipeExpr, fieldMap: Map<string, number>, fnEnv?: WGSLFnEnv): string {
  let result = exprToWGSL(expr.input, fieldMap, fnEnv)

  for (const transform of expr.transforms) {
    const name = transform.callee.kind === 'Identifier' ? transform.callee.name : null
    if (!name) continue

    const extraArgs = transform.args.map(a => exprToWGSL(a, fieldMap, fnEnv))

    // Pipe passes result as first arg
    if (name === 'scale') {
      result = `(${result} * ${extraArgs[0] ?? '1.0'})`
    } else if (name === 'step') {
      result = `select(${extraArgs[2] ?? '1.0'}, ${extraArgs[1] ?? '0.0'}, ${result} < ${extraArgs[0] ?? '0.0'})`
    } else if (name === 'log10') {
      result = `(log(max(${result}, 1e-10)) / log(10.0))`
    } else {
      const wgslName = WGSL_BUILTINS[name]
      if (wgslName) {
        result = `${wgslName}(${result}, ${extraArgs.join(', ')})`
      }
    }
  }

  return result
}

/**
 * Inline a user-defined function by substituting args into the body expression.
 * Only works for single-expression function bodies.
 */
function inlineUserFn(
  fn: AST.FnStatement,
  argExprs: string[],
  fieldMap: Map<string, number>,
  fnEnv?: WGSLFnEnv,
): string {
  // Build param → WGSL expression mapping
  const paramMap = new Map<string, string>()
  fn.params.forEach((p, i) => {
    paramMap.set(p.name, argExprs[i] ?? '0.0')
  })

  // Find the expression in the body (last ExprStatement)
  for (let i = fn.body.length - 1; i >= 0; i--) {
    const stmt = fn.body[i]
    if (stmt.kind === 'ExprStatement') {
      return substituteParams(stmt.expr, paramMap, fieldMap, fnEnv)
    }
  }

  return '0.0'
}

/** Recursively substitute parameter names with their WGSL expressions */
function substituteParams(
  expr: AST.Expr,
  paramMap: Map<string, string>,
  fieldMap: Map<string, number>,
  fnEnv?: WGSLFnEnv,
): string {
  switch (expr.kind) {
    case 'Identifier': {
      // Check if it's a function parameter
      const sub = paramMap.get(expr.name)
      if (sub !== undefined) return sub
      return exprToWGSL(expr, fieldMap, fnEnv)
    }

    case 'BinaryExpr': {
      const left = substituteParams(expr.left, paramMap, fieldMap, fnEnv)
      const right = substituteParams(expr.right, paramMap, fieldMap, fnEnv)
      const op = wgslOp(expr.op)
      if (op) return `(${left} ${op} ${right})`
      return `(${left} ${expr.op} ${right})`
    }

    case 'UnaryExpr': {
      const operand = substituteParams(expr.operand, paramMap, fieldMap, fnEnv)
      if (expr.op === '-') return `(-${operand})`
      return operand
    }

    case 'FnCall': {
      const name = expr.callee.kind === 'Identifier' ? expr.callee.name : null
      const args = expr.args.map(a => substituteParams(a, paramMap, fieldMap, fnEnv))
      if (!name) return '0.0'

      if (name === 'scale') return `(${args[0] ?? '0.0'} * ${args[1] ?? '1.0'})`
      if (name === 'log10') return `(log(max(${args[0] ?? '0.0'}, 1e-10)) / log(10.0))`

      const wgslName = WGSL_BUILTINS[name]
      if (wgslName) return `${wgslName}(${args.join(', ')})`
      return '0.0'
    }

    default:
      return exprToWGSL(expr, fieldMap, fnEnv)
  }
}

function wgslOp(op: string): string | null {
  switch (op) {
    case '+': case '-': case '*': case '/': case '%':
      return op
    default:
      return null
  }
}

function formatFloat(n: number): string {
  const s = String(n)
  if (s.includes('.') || s.includes('e') || s.includes('E')) return s
  return s + '.0'
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
      expr.args.forEach(a => walkExpr(a, fields))
      break
    case 'PipeExpr':
      walkExpr(expr.input, fields)
      expr.transforms.forEach(t => t.args.forEach(a => walkExpr(a, fields)))
      break
  }
}
