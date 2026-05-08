// ═══ Expression Evaluator ═══
// Evaluates AST expressions against a feature property bag.
// Used for data-driven styling: size-[speed / 50 | clamp(4, 24)]

import type * as AST from '../parser/ast'

/** A bag of feature properties (e.g., from GeoJSON properties). The
 *  reserved key `$zoom` carries the current camera zoom level when
 *  the caller wants `zoom`-keyed builtins (`interpolate(zoom, …)`)
 *  to evaluate to a concrete number. Callers that don't supply
 *  `$zoom` get null for the `zoom` identifier — same shape as a
 *  missing feature property. */
export type FeatureProps = Record<string, unknown>

/** Environment of user-defined functions for compile-time evaluation */
export type FnEnv = Map<string, AST.FnStatement>

/**
 * Evaluate an expression against feature properties.
 * Returns a number, string, boolean, or null.
 * @param fnEnv Optional user-defined function environment for compile-time evaluation
 */
export function evaluate(expr: AST.Expr, props: FeatureProps, fnEnv?: FnEnv): unknown {
  switch (expr.kind) {
    case 'NumberLiteral':
      return expr.value
    case 'StringLiteral':
      return expr.value
    case 'ColorLiteral':
      return expr.value
    case 'BoolLiteral':
      return expr.value
    case 'Identifier':
      // Special runtime identifier `zoom` — caller injects via the
      // `$zoom` reserved key so the same evaluator works for
      // per-feature (worker, no zoom available) and per-frame
      // (renderer, zoom known) call sites without API divergence.
      if (expr.name === 'zoom') return props['$zoom'] ?? null
      return props[expr.name] ?? null
    case 'FieldAccess':
      return evaluateFieldAccess(expr, props, fnEnv)
    case 'BinaryExpr':
      return evaluateBinary(expr, props, fnEnv)
    case 'UnaryExpr':
      return evaluateUnary(expr, props, fnEnv)
    case 'FnCall':
      return evaluateFnCall(expr, props, fnEnv)
    case 'PipeExpr':
      return evaluatePipe(expr, props, fnEnv)
    case 'MatchBlock':
      return evaluateMatch(expr, props, fnEnv)
    case 'ConditionalExpr':
      return toBool(evaluate(expr.condition, props, fnEnv))
        ? evaluate(expr.thenExpr, props, fnEnv)
        : evaluate(expr.elseExpr, props, fnEnv)
    case 'ArrayLiteral':
      return expr.elements.map(e => evaluate(e, props, fnEnv))
    case 'ArrayAccess': {
      const arr = evaluate(expr.array, props, fnEnv)
      const idx = toNumber(evaluate(expr.index, props, fnEnv))
      return Array.isArray(arr) ? arr[Math.floor(idx)] ?? null : null
    }
    default:
      return null
  }
}

function evaluateFieldAccess(expr: AST.FieldAccess, props: FeatureProps, _fnEnv?: FnEnv): unknown {
  if (expr.object === null) {
    // Implicit field access: .speed → props["speed"]
    return props[expr.field] ?? null
  }
  // Chained: obj.field
  const obj = evaluate(expr.object, props)
  if (obj && typeof obj === 'object') {
    return (obj as Record<string, unknown>)[expr.field] ?? null
  }
  return null
}

function evaluateBinary(expr: AST.BinaryExpr, props: FeatureProps, fnEnv?: FnEnv): unknown {
  const left = evaluate(expr.left, props, fnEnv)
  // `??` short-circuits — only evaluates RHS when LHS is null /
  // undefined / non-finite numeric. Mirrors JS semantics so a
  // style author can write `extrude: .height ?? 50` to get the
  // raw `.height` when present and fall back to 50 when missing.
  // Evaluated BEFORE coercing to number so `0` and `false` stay
  // as themselves on the left and don't trigger fallback.
  if (expr.op === '??') {
    if (left === null || left === undefined) return evaluate(expr.right, props, fnEnv)
    if (typeof left === 'number' && !Number.isFinite(left)) return evaluate(expr.right, props, fnEnv)
    return left
  }
  const right = evaluate(expr.right, props, fnEnv)

  const l = toNumber(left)
  const r = toNumber(right)

  switch (expr.op) {
    case '+': return l + r
    case '-': return l - r
    case '*': return l * r
    case '/': return r !== 0 ? l / r : 0
    case '%': return r !== 0 ? l % r : 0
    case '==': return left === right
    case '!=': return left !== right
    case '<': return l < r
    case '>': return l > r
    case '<=': return l <= r
    case '>=': return l >= r
    case '&&': return toBool(left) && toBool(right)
    case '||': return toBool(left) || toBool(right)
    default: return null
  }
}

function evaluateUnary(expr: AST.UnaryExpr, props: FeatureProps, fnEnv?: FnEnv): unknown {
  const val = evaluate(expr.operand, props, fnEnv)
  switch (expr.op) {
    case '-': return -toNumber(val)
    case '!': return !toBool(val)
    default: return null
  }
}

/** Sentinel for early return from function body */
class ReturnSignal { constructor(public value: unknown) {} }

const MAX_LOOP_ITERATIONS = 10000

/** Execute a list of statements, returning the last expression value or ReturnSignal */
function executeBody(body: AST.Statement[], scope: FeatureProps, fnEnv?: FnEnv): unknown {
  let result: unknown = null
  for (const stmt of body) {
    switch (stmt.kind) {
      case 'ExprStatement':
        result = evaluate(stmt.expr, scope, fnEnv)
        break
      case 'LetStatement':
        scope[stmt.name] = evaluate(stmt.value, scope, fnEnv)
        break
      case 'ReturnStatement':
        return new ReturnSignal(stmt.value ? evaluate(stmt.value, scope, fnEnv) : null)
      case 'IfStatement': {
        const cond = toBool(evaluate(stmt.condition, scope, fnEnv))
        const branch = cond ? stmt.thenBranch : stmt.elseBranch
        if (branch) {
          const r = executeBody(branch, scope, fnEnv)
          if (r instanceof ReturnSignal) return r
          result = r
        }
        break
      }
      case 'ForStatement': {
        const startVal = Math.floor(toNumber(evaluate(stmt.start, scope, fnEnv)))
        const endVal = Math.floor(toNumber(evaluate(stmt.end, scope, fnEnv)))
        const iterations = Math.min(Math.abs(endVal - startVal), MAX_LOOP_ITERATIONS)
        for (let i = 0; i < iterations; i++) {
          scope[stmt.variable] = startVal + i
          const r = executeBody(stmt.body, scope, fnEnv)
          if (r instanceof ReturnSignal) return r
          result = r
        }
        break
      }
      default: break
    }
  }
  return result
}

function evaluateFnCall(expr: AST.FnCall, props: FeatureProps, fnEnv?: FnEnv): unknown {
  const name = expr.callee.kind === 'Identifier' ? expr.callee.name : null
  if (!name) return null

  // `match(.field) { value -> result, ..., _ -> default }` — the
  // matchBlock hangs off the FnCall via the parser, so we have to
  // dispatch here BEFORE the builtin lookup. Without this the
  // worker's `extractFeatureColors` / `extractFeatureWidths` (used
  // by the layer-merge pass) silently received null for every
  // feature → no per-feature stroke colour / width was ever baked
  // into the segment buffer; the visible symptom on the iPhone
  // osm_style demo was every road in the compound layer
  // rendering at the FIRST member's colour because the segment
  // override stayed at 0 (alpha=0 sentinel = "use layer colour").
  if (name === 'match' && expr.matchBlock && expr.args.length === 1) {
    const key = evaluate(expr.args[0], props, fnEnv)
    const keyStr = key === null || key === undefined ? null : String(key)
    if (keyStr !== null) {
      for (const arm of expr.matchBlock.arms) {
        if (arm.pattern === '_') continue
        if (arm.pattern === keyStr) return evaluate(arm.value, props, fnEnv)
      }
    }
    const defaultArm = expr.matchBlock.arms.find(a => a.pattern === '_')
    return defaultArm ? evaluate(defaultArm.value, props, fnEnv) : null
  }

  const args = expr.args.map(a => evaluate(a, props, fnEnv))

  // Try user-defined function first (higher priority than builtins)
  if (fnEnv) {
    const fn = fnEnv.get(name)
    if (fn) {
      const fnProps: FeatureProps = { ...props }
      fn.params.forEach((p, i) => { fnProps[p.name] = args[i] })
      const r = executeBody(fn.body, fnProps, fnEnv)
      return r instanceof ReturnSignal ? r.value : r
    }
  }

  return callBuiltin(name, args)
}

function evaluatePipe(expr: AST.PipeExpr, props: FeatureProps, fnEnv?: FnEnv): unknown {
  let value = evaluate(expr.input, props, fnEnv)

  for (const transform of expr.transforms) {
    const name = transform.callee.kind === 'Identifier' ? transform.callee.name : null
    if (!name) continue

    const args = transform.args.map(a => evaluate(a, props, fnEnv))
    value = callBuiltin(name, [value, ...args])
  }

  return value
}

function evaluateMatch(expr: AST.MatchBlock, props: FeatureProps, _fnEnv?: FnEnv): unknown {
  // Not yet generated by parser, but ready for future use
  for (const arm of expr.arms) {
    if (arm.pattern === '_') continue
    // Simple string match against props
    if (props[arm.pattern] !== undefined) {
      return evaluate(arm.value, props)
    }
  }
  // Default arm
  const defaultArm = expr.arms.find(a => a.pattern === '_')
  return defaultArm ? evaluate(defaultArm.value, props) : null
}

// ═══ Built-in functions ═══

function callBuiltin(name: string, args: unknown[]): unknown {
  switch (name) {
    case 'clamp': {
      const [val, min, max] = args.map(toNumber)
      return Math.max(min, Math.min(max, val))
    }
    case 'min': return Math.min(...args.map(toNumber))
    case 'max': return Math.max(...args.map(toNumber))
    case 'round': return Math.round(toNumber(args[0]))
    case 'floor': return Math.floor(toNumber(args[0]))
    case 'ceil': return Math.ceil(toNumber(args[0]))
    case 'abs': return Math.abs(toNumber(args[0]))
    case 'sqrt': return Math.sqrt(toNumber(args[0]))
    case 'log10': return Math.log10(Math.max(1e-10, toNumber(args[0])))
    case 'log2': return Math.log2(Math.max(1e-10, toNumber(args[0])))
    case 'scale': return toNumber(args[0]) * toNumber(args[1])
    case 'step': {
      const [val, threshold, below, above] = args.map(toNumber)
      return val < threshold ? below : above
    }
    case 'interpolate': {
      // interpolate(input, x1, y1, x2, y2, …) — linear interpolation
      // between (xi, yi) stops. The first arg is the input value
      // (typically `zoom` or a feature property); subsequent args
      // alternate stop key + stop value. Pass-through when input is
      // outside the stop range (clamps to first / last). Numeric
      // values interpolate; non-numeric (e.g. color hex strings)
      // pick the nearest stop without blending.
      if (args.length < 3 || (args.length - 1) % 2 !== 0) return null
      const input = toNumber(args[0])
      // Build (x, y) pairs.
      const stops: Array<{ x: number; y: unknown }> = []
      for (let i = 1; i + 1 < args.length; i += 2) {
        stops.push({ x: toNumber(args[i]), y: args[i + 1] })
      }
      if (stops.length === 0) return null
      if (input <= stops[0].x) return stops[0].y
      if (input >= stops[stops.length - 1].x) return stops[stops.length - 1].y
      for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i], b = stops[i + 1]
        if (input >= a.x && input <= b.x) {
          if (typeof a.y === 'number' && typeof b.y === 'number') {
            const t = (input - a.x) / (b.x - a.x)
            return a.y + (b.y - a.y) * t
          }
          // Non-numeric — pick the closer stop.
          return (input - a.x) < (b.x - input) ? a.y : b.y
        }
      }
      return stops[0].y
    }
    // Trigonometry
    case 'sin': return Math.sin(toNumber(args[0]))
    case 'cos': return Math.cos(toNumber(args[0]))
    case 'tan': return Math.tan(toNumber(args[0]))
    case 'asin': return Math.asin(toNumber(args[0]))
    case 'acos': return Math.acos(toNumber(args[0]))
    case 'atan': return Math.atan(toNumber(args[0]))
    case 'atan2': return Math.atan2(toNumber(args[0]), toNumber(args[1]))
    // Exponential
    case 'pow': return Math.pow(toNumber(args[0]), toNumber(args[1]))
    case 'exp': return Math.exp(toNumber(args[0]))
    case 'log': return Math.log(Math.max(1e-10, toNumber(args[0])))
    // Constants
    case 'PI': return Math.PI
    case 'TAU': return Math.PI * 2
    // Array
    case 'length': return Array.isArray(args[0]) ? args[0].length : 0
    // Geometry generators — return coordinate arrays
    case 'circle': {
      const [cx, cy, r, s] = args.map(toNumber)
      const steps = Math.max(4, Math.floor(s || 32))
      const pts: number[][] = []
      for (let i = 0; i <= steps; i++) {
        const a = (i % steps) * Math.PI * 2 / steps
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
      }
      return pts
    }
    case 'arc': {
      const [cx, cy, r, startA, endA, s] = args.map(toNumber)
      const steps = Math.max(2, Math.floor(s || 32))
      const pts: number[][] = []
      for (let i = 0; i <= steps; i++) {
        const a = startA + (endA - startA) * i / steps
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
      }
      return pts
    }
    case 'polygon': {
      // polygon(points) — wrap as GeoJSON-style ring (close if not closed)
      const pts = args[0] as number[][]
      if (!Array.isArray(pts)) return null
      return { type: 'Polygon', coordinates: [pts] }
    }
    case 'linestring': {
      const pts = args[0] as number[][]
      if (!Array.isArray(pts)) return null
      return { type: 'LineString', coordinates: pts }
    }
    default:
      return args[0] ?? null
  }
}

// ═══ Type coercion helpers ═══

function toNumber(val: unknown): number {
  if (typeof val === 'number') return val
  if (typeof val === 'string') {
    const n = parseFloat(val)
    return isNaN(n) ? 0 : n
  }
  if (typeof val === 'boolean') return val ? 1 : 0
  return 0
}

function toBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  if (typeof val === 'string') return val !== ''
  return val !== null && val !== undefined
}

export { toNumber, toBool }
