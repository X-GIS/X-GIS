// ═══ Expression Evaluator ═══
// Evaluates AST expressions against a feature property bag.
// Used for data-driven styling: size-[speed / 50 | clamp(4, 24)]

import type * as AST from '../parser/ast'
import { CAMERA_ZOOM_KEY, CAMERA_PITCH_KEY } from './reserved-keys'
import { callBuiltin, toNumber, toBool } from './evaluator-helpers'
import type { FeatureProps, FnEnv } from './evaluator-types'

// Public surface preserved: FeatureProps / FnEnv re-exported here
// (FeatureProps is also re-exported from compiler/src/index.ts).
export type { FeatureProps, FnEnv } from './evaluator-types'

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
      // `CAMERA_ZOOM_KEY` reserved key (see ./reserved-keys.ts) so
      // the same evaluator works for per-feature (worker, no zoom
      // available) and per-frame (renderer, zoom known) call sites
      // without API divergence.
      if (expr.name === 'zoom') return props[CAMERA_ZOOM_KEY] ?? null
      // Special runtime identifier `pitch` — Mapbox `["pitch"]`. Same
      // reserved-key injection contract as `zoom`; render-path sites
      // inject the live camera pitch, decode-time sites leave it null.
      if (expr.name === 'pitch') return props[CAMERA_PITCH_KEY] ?? null
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

function evaluateFieldAccess(expr: AST.FieldAccess, props: FeatureProps, fnEnv?: FnEnv): unknown {
  if (expr.object === null) {
    // Implicit field access: .speed → props["speed"]
    return props[expr.field] ?? null
  }
  // Chained: obj.field — forward fnEnv so a user-defined fn nested
  // inside the object expression still resolves (e.g. `myFn(.x).b`).
  // Pre-fix the omitted forward dropped fnEnv at the chain boundary
  // and the inner FnCall fell back to props-only lookup, returning
  // null for any user-defined fn.
  const obj = evaluate(expr.object, props, fnEnv)
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
  // Short-circuit boolean operators BEFORE eagerly evaluating RHS.
  // Matches JS semantics + Mapbox spec for `all` / `any` (which the
  // converter lowers to chains of && / ||). Skipping the right side
  // when the left is determinative saves work on expensive subtrees
  // AND prevents RHS exceptions from poisoning a filter whose LHS
  // already short-circuited (a divide-by-zero on field X in `["all",
  // ["==", .kind, "park"], ["/", .area, 0]]` previously evaluated
  // .area/0 even for non-park features).
  if (expr.op === '&&') {
    if (!toBool(left)) return false
    return toBool(evaluate(expr.right, props, fnEnv))
  }
  if (expr.op === '||') {
    if (toBool(left)) return true
    return toBool(evaluate(expr.right, props, fnEnv))
  }
  const right = evaluate(expr.right, props, fnEnv)

  // Mapbox spec: ordered comparison (< > <= >=) works on numbers AND
  // strings (lex compare). Pre-fix the evaluator coerced both sides
  // via toNumber → toNumber("abc")=0, toNumber("xyz")=0 → 0<0=false
  // → the entire ordered string compare was always-false. Names
  // like ["<", "name1", "name2"] for symbol-sort-key emulation
  // silently broke. Fall to lex compare when both sides are strings.
  //
  // Iter 531: Mapbox spec also says ordered comparisons with a null
  // / undefined operand return FALSE (reject the filter). Pre-fix
  // toNumber(null)=0 silently passed `(.ref_length <= 6)` for
  // features WITHOUT a ref_length field — letting OFM Bright's
  // highway-shield-* layers feed undefined-ref_length features into
  // the icon-image expression `concat("road_", get("ref_length"))`
  // which resolved to "road_" (concat skips nulls), atlas missed,
  // and the shield silently vanished. Diagnostic: pixel-match-
  // survey-labels reported `missingIcons: ["road_"]` at iter 531.
  if (expr.op === '<' || expr.op === '>' || expr.op === '<=' || expr.op === '>=') {
    if (left === null || left === undefined || right === null || right === undefined) {
      return false
    }
    // iter-293 — non-finite numeric operand rejects ordered compare.
    // `toNumber()` defensively strips NaN/Infinity to 0; without this
    // guard, `(NaN < 5)` evaluates as `(0 < 5)` = true. Extension of
    // the iter-531 null/undefined rule, same spirit as Mapbox spec
    // "comparable operand required". Surfaced by iter-293 fuzz.
    if (typeof left === 'number' && !Number.isFinite(left)) return false
    if (typeof right === 'number' && !Number.isFinite(right)) return false
    // Mapbox v8 spec — ordered comparison requires BOTH operands to be
    // the same type (both numbers or both strings). Mixed-type returns
    // false. Iter 536 added — pre-fix `"abc" < 5` evaluated via the
    // toNumber fallback (toNumber("abc")=0 → 0<5=true) which would
    // let a string-typed MVT attribute slip past a numeric filter
    // (e.g. ref_length stored as "5" string by some MVT encoders →
    // "5" < 6 → true, allowing the shield through; spec says false).
    if (typeof left === 'string' && typeof right === 'string') {
      switch (expr.op) {
        case '<': return left < right
        case '>': return left > right
        case '<=': return left <= right
        case '>=': return left >= right
      }
    }
    if (typeof left !== 'number' || typeof right !== 'number') {
      return false
    }
  }
  const l = toNumber(left)
  const r = toNumber(right)

  // Guard intermediate arithmetic against overflow → Infinity, which
  // would otherwise propagate through downstream multiplications and
  // produce NaN buffer values via Infinity * 0. Coerce non-finite
  // arithmetic results to 0 (consistent with toNumber's non-finite
  // sentinel at c6aa3b0).
  const finite = (n: number): number => Number.isFinite(n) ? n : 0
  switch (expr.op) {
    case '+': return finite(l + r)
    case '-': return finite(l - r)
    case '*': return finite(l * r)
    case '/': return r !== 0 ? finite(l / r) : 0
    case '%': return r !== 0 ? finite(l % r) : 0
    case '==': return left === right
    case '!=': return left !== right
    case '<': return l < r
    case '>': return l > r
    case '<=': return l <= r
    case '>=': return l >= r
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
  // `get("name:ko")` — Mapbox locale-variant property access. xgis
  // FieldAccess (`.foo`) lexes as identifier so colon-bearing keys
  // (`name:ko`, `name:latin`, `name_int`-prefixed locale forms…)
  // can't ride the bare-dot path. Detect the AST shape here so the
  // converter can emit `get("name:ko")` instead of dropping with a
  // warning. Numeric / dynamic keys also work — args[0] is evaluated
  // against props before lookup, so `get(.field_name)` would chain.
  if (name === 'get' && expr.args.length === 1) {
    const keyArg = expr.args[0]
    if (keyArg.kind === 'StringLiteral') {
      return props[keyArg.value] ?? null
    }
    const dynKey = evaluate(keyArg, props, fnEnv)
    if (typeof dynKey === 'string') return props[dynKey] ?? null
    return null
  }

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

function evaluateMatch(expr: AST.MatchBlock, props: FeatureProps, fnEnv?: FnEnv): unknown {
  // Not yet generated by parser, but ready for future use.
  // Forward fnEnv so user-defined fns nested inside arm values still
  // resolve (mirror of the FieldAccess fnEnv-forward fix; same
  // dropped-fnEnv class).
  for (const arm of expr.arms) {
    if (arm.pattern === '_') continue
    // Simple string match against props
    if (props[arm.pattern] !== undefined) {
      return evaluate(arm.value, props, fnEnv)
    }
  }
  // Default arm
  const defaultArm = expr.arms.find(a => a.pattern === '_')
  return defaultArm ? evaluate(defaultArm.value, props, fnEnv) : null
}

// ═══ Built-in functions + type coercion helpers ═══
// Moved verbatim to ./evaluator-helpers.ts (pure, no eval-tree
// coupling). Imported above for internal use; no longer re-exported
// here (no external consumer of the evaluator-level re-export).
