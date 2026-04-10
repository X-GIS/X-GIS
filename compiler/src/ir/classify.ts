// ═══ Expression Classifier ═══
// Determines where an expression should be evaluated:
//   constant        → compile-time (fold to literal)
//   zoom-dependent  → per-frame CPU (uniform)
//   per-feature-gpu → per-feature GPU (WGSL codegen)
//   per-feature-cpu → per-feature CPU (storage buffer upload)

import type * as AST from '../parser/ast'

export type ExprClass = 'constant' | 'zoom-dependent' | 'per-feature-gpu' | 'per-feature-cpu'

/** GPU-safe built-in functions that map directly to WGSL */
const GPU_SAFE_BUILTINS = new Set([
  'clamp', 'min', 'max', 'round', 'floor', 'ceil', 'abs', 'sqrt',
  'log', 'log2', 'exp', 'exp2', 'pow', 'step', 'scale',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
])

/** Function environment for user-defined function classification */
export type FnEnv = Map<string, AST.FnStatement>

/**
 * Classify an expression to determine where it should be evaluated.
 */
export function classifyExpr(expr: AST.Expr, fnEnv?: FnEnv): ExprClass {
  switch (expr.kind) {
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'ColorLiteral':
    case 'BoolLiteral':
      return 'constant'

    case 'Identifier':
      if (expr.name === 'zoom') return 'zoom-dependent'
      return 'per-feature-gpu'

    case 'FieldAccess':
      return 'per-feature-gpu'

    case 'BinaryExpr':
      return merge(
        classifyExpr(expr.left, fnEnv),
        classifyExpr(expr.right, fnEnv),
      )

    case 'UnaryExpr':
      return classifyExpr(expr.operand, fnEnv)

    case 'FnCall':
      return classifyFnCall(expr, fnEnv)

    case 'PipeExpr':
      return classifyPipe(expr, fnEnv)

    case 'MatchBlock':
      return classifyMatch(expr, fnEnv)

    default:
      return 'per-feature-cpu'
  }
}

function classifyFnCall(expr: AST.FnCall, fnEnv?: FnEnv): ExprClass {
  const name = expr.callee.kind === 'Identifier' ? expr.callee.name : null

  // Classify all arguments
  const argClasses = expr.args.map(a => classifyExpr(a, fnEnv))
  const argsClass = argClasses.reduce<ExprClass>((acc, c) => merge(acc, c), 'constant')

  if (!name) return merge(argsClass, 'per-feature-cpu')

  // Built-in GPU-safe function
  if (GPU_SAFE_BUILTINS.has(name)) {
    return argsClass
  }

  // User-defined function
  if (fnEnv?.has(name)) {
    const fn = fnEnv.get(name)!
    const bodyClass = classifyFnBody(fn, argClasses, fnEnv)
    return merge(argsClass, bodyClass)
  }

  // Unknown function → CPU fallback
  return merge(argsClass, 'per-feature-cpu')
}

function classifyFnBody(fn: AST.FnStatement, argClasses: ExprClass[], fnEnv?: FnEnv): ExprClass {
  // Create a param → class mapping
  const paramClasses = new Map<string, ExprClass>()
  fn.params.forEach((p, i) => {
    paramClasses.set(p.name, argClasses[i] ?? 'constant')
  })

  // Classify each statement in the body
  let result: ExprClass = 'constant'
  for (const stmt of fn.body) {
    if (stmt.kind === 'ExprStatement') {
      result = merge(result, classifyWithParams(stmt.expr, paramClasses, fnEnv))
    } else if (stmt.kind === 'LetStatement') {
      result = merge(result, classifyWithParams(stmt.value, paramClasses, fnEnv))
    }
  }
  return result
}

/** Classify expression where identifiers may be function parameters */
function classifyWithParams(expr: AST.Expr, paramClasses: Map<string, ExprClass>, fnEnv?: FnEnv): ExprClass {
  switch (expr.kind) {
    case 'Identifier':
      if (expr.name === 'zoom') return 'zoom-dependent'
      // Check if it's a function parameter
      if (paramClasses.has(expr.name)) return paramClasses.get(expr.name)!
      return 'per-feature-gpu'

    case 'BinaryExpr':
      return merge(
        classifyWithParams(expr.left, paramClasses, fnEnv),
        classifyWithParams(expr.right, paramClasses, fnEnv),
      )

    case 'UnaryExpr':
      return classifyWithParams(expr.operand, paramClasses, fnEnv)

    case 'FnCall': {
      const argClasses = expr.args.map(a => classifyWithParams(a, paramClasses, fnEnv))
      const argsClass = argClasses.reduce<ExprClass>((acc, c) => merge(acc, c), 'constant')
      const name = expr.callee.kind === 'Identifier' ? expr.callee.name : null
      if (name && GPU_SAFE_BUILTINS.has(name)) return argsClass
      if (name && fnEnv?.has(name)) {
        return merge(argsClass, classifyFnBody(fnEnv.get(name)!, argClasses, fnEnv))
      }
      return merge(argsClass, 'per-feature-cpu')
    }

    case 'PipeExpr': {
      let cls = classifyWithParams(expr.input, paramClasses, fnEnv)
      for (const t of expr.transforms) {
        const tArgs = t.args.map(a => classifyWithParams(a, paramClasses, fnEnv))
        const name = t.callee.kind === 'Identifier' ? t.callee.name : null
        if (name && GPU_SAFE_BUILTINS.has(name)) {
          cls = tArgs.reduce((acc, c) => merge(acc, c), cls)
        } else {
          cls = merge(cls, 'per-feature-cpu')
        }
      }
      return cls
    }

    default:
      return classifyExpr(expr, fnEnv)
  }
}

function classifyPipe(expr: AST.PipeExpr, fnEnv?: FnEnv): ExprClass {
  let cls = classifyExpr(expr.input, fnEnv)
  for (const transform of expr.transforms) {
    cls = merge(cls, classifyFnCall(transform, fnEnv))
  }
  return cls
}

function classifyMatch(expr: AST.MatchBlock, fnEnv?: FnEnv): ExprClass {
  let cls: ExprClass = 'per-feature-gpu' // match always depends on data
  for (const arm of expr.arms) {
    cls = merge(cls, classifyExpr(arm.value, fnEnv))
  }
  return cls
}

/** Merge two classifications — the "heavier" one wins */
function merge(a: ExprClass, b: ExprClass): ExprClass {
  const order: Record<ExprClass, number> = {
    'constant': 0,
    'zoom-dependent': 1,
    'per-feature-gpu': 2,
    'per-feature-cpu': 3,
  }
  return order[a] >= order[b] ? a : b
}
