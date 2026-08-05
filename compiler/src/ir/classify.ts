// ═══ Expression Classifier ═══
// Determines where an expression should be evaluated:
//   constant        → compile-time (fold to literal)
//   zoom-dependent  → per-frame CPU (uniform)
//   per-feature-gpu → per-feature GPU (WGSL codegen)
//   per-feature-cpu → per-feature CPU (storage buffer upload)

import type * as AST from '../parser/ast'

export type ExprClass =
  'constant' | 'zoom-dependent' | 'input-dependent' | 'per-feature-gpu' | 'per-feature-cpu'

/** GPU-safe built-in functions that map directly to WGSL. Exported so a
 *  test can assert this set ⊆ `BUILTIN_FN_NAMES` — every name routed to GPU
 *  codegen must also be CPU-evaluable for the per-feature-CPU fallback and
 *  const-fold paths (the pre-#1066 `exp2` gap broke exactly that). */
export const GPU_SAFE_BUILTINS = new Set([
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
  'step',
  'scale',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  // Vector constructors (#1537). GPU-safe since step B: `fnCallToNode`
  // builds a real `vecN(...)` construction node, and a vec reaching a
  // scalar binding is rejected at lower time (X-GIS0018) rather than
  // emitted wrong. `callBuiltin` evaluates them too, so the documented
  // callBuiltin ⊇ GPU_SAFE_BUILTINS invariant holds.
  'vec2',
  'vec3',
  'vec4',
])

/**
 * Classify an expression to determine where it should be evaluated.
 */
export function classifyExpr(expr: AST.Expr): ExprClass {
  switch (expr.kind) {
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'ColorLiteral':
    case 'BoolLiteral':
      return 'constant'

    case 'Identifier':
      if (expr.name === 'zoom') return 'zoom-dependent'
      return 'per-feature-gpu'

    // A declared `input` (#1539) — a per-frame uniform, never per-feature.
    // Resolved to this distinct kind by ir/resolve-inputs.ts before this
    // function ever runs, so there is no name to string-match here (unlike
    // `zoom` above); every InputRef reaching classify is already known-good.
    case 'InputRef':
      return 'input-dependent'

    case 'FieldAccess':
      // An EXPLICIT object must be classified through — an expression is
      // only as GPU-safe as its parts. Pre-#1537 this arm returned
      // per-feature-gpu unconditionally, which was harmless while
      // object-bearing access resolved by field name anyway; with real
      // vector component reads (`vec2(cpuOnly(…), 1).x`) it would have
      // sent a CPU-only body down the GPU path, where an unknown callee
      // emits `0.0` — a silent wrong value. The object-less form (the
      // `.field` data binding) keeps its per-feature-gpu class.
      return expr.object ? classifyExpr(expr.object) : 'per-feature-gpu'

    case 'BinaryExpr':
      return merge(classifyExpr(expr.left), classifyExpr(expr.right))

    case 'UnaryExpr':
      return classifyExpr(expr.operand)

    case 'FnCall':
      return classifyFnCall(expr)

    case 'MatchBlock':
      return classifyMatch(expr)

    case 'ConditionalExpr':
      return merge(
        classifyExpr(expr.condition),
        merge(classifyExpr(expr.thenExpr), classifyExpr(expr.elseExpr)),
      )

    case 'ArrayLiteral':
    case 'ArrayAccess':
      return 'per-feature-cpu' // arrays can't go to GPU

    default:
      return 'per-feature-cpu'
  }
}

function classifyFnCall(expr: AST.FnCall): ExprClass {
  const name = expr.callee.kind === 'Identifier' ? expr.callee.name : null

  // Classify all arguments
  const argClasses = expr.args.map((a) => classifyExpr(a))
  const argsClass = argClasses.reduce<ExprClass>((acc, c) => merge(acc, c), 'constant')

  if (!name) return merge(argsClass, 'per-feature-cpu')

  // Built-in GPU-safe function
  if (GPU_SAFE_BUILTINS.has(name)) {
    return argsClass
  }

  // Unknown function → CPU fallback
  return merge(argsClass, 'per-feature-cpu')
}

function classifyMatch(expr: AST.MatchBlock): ExprClass {
  let cls: ExprClass = 'per-feature-gpu' // match always depends on data
  for (const arm of expr.arms) {
    cls = merge(cls, classifyExpr(arm.value))
  }
  return cls
}

/** Merge two classifications — the "heavier" one wins */
function merge(a: ExprClass, b: ExprClass): ExprClass {
  const order: Record<ExprClass, number> = {
    constant: 0,
    'zoom-dependent': 1,
    'input-dependent': 1,
    'per-feature-gpu': 2,
    'per-feature-cpu': 3,
  }
  return order[a] >= order[b] ? a : b
}
