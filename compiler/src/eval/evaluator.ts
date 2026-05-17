// ═══ Expression Evaluator ═══
// Evaluates AST expressions against a feature property bag.
// Used for data-driven styling: size-[speed / 50 | clamp(4, 24)]

import type * as AST from '../parser/ast'
import { CAMERA_ZOOM_KEY } from './reserved-keys'

/** A bag of feature properties (e.g., from GeoJSON properties). The
 *  reserved key {@link CAMERA_ZOOM_KEY} (`$zoom`) carries the current
 *  camera zoom level when the caller wants `zoom`-keyed builtins
 *  (`interpolate(zoom, …)`) to evaluate to a concrete number. Callers
 *  that don't supply that key get null for the `zoom` identifier —
 *  same shape as a missing feature property. */
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
      // `CAMERA_ZOOM_KEY` reserved key (see ./reserved-keys.ts) so
      // the same evaluator works for per-feature (worker, no zoom
      // available) and per-frame (renderer, zoom known) call sites
      // without API divergence.
      if (expr.name === 'zoom') return props[CAMERA_ZOOM_KEY] ?? null
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
  if (expr.op === '<' || expr.op === '>' || expr.op === '<=' || expr.op === '>=') {
    if (typeof left === 'string' && typeof right === 'string') {
      switch (expr.op) {
        case '<': return left < right
        case '>': return left > right
        case '<=': return left <= right
        case '>=': return left >= right
      }
    }
  }
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
    case 'sqrt': {
      // Math.sqrt(-1) = NaN; clamp negative inputs to 0 so the NaN
      // doesn't propagate into downstream arithmetic (consistent with
      // toNumber's non-finite → 0 fallback at c6aa3b0).
      const x = toNumber(args[0])
      return x < 0 ? 0 : Math.sqrt(x)
    }
    case 'log10': return Math.log10(Math.max(1e-10, toNumber(args[0])))
    case 'log2': return Math.log2(Math.max(1e-10, toNumber(args[0])))
    case 'scale': return toNumber(args[0]) * toNumber(args[1])
    case 'step': {
      // Two shapes:
      //   (a) Legacy 4-arg:  step(val, threshold, below, above)
      //   (b) Mapbox N-stop: step(input, def, stop1, val1, stop2, val2, …)
      //                      result = def while input < stop1, else
      //                      walks stops left-to-right and returns the
      //                      val for the largest stop_i ≤ input.
      //
      // Both shapes have args.length === 4 in the minimal N-stop case,
      // so arg-count alone can't disambiguate. Look at args[2]:
      //   - Legacy: args[2] = `below` (any type — colour, string, etc.)
      //   - N-stop: args[2] = `stop1` (MUST be numeric — the cutoff)
      // → numeric args[2] picks N-stop, non-numeric picks legacy.
      // Pre-fix the 4-arg branch unconditionally treated as legacy,
      // which broke the Mapbox-converter emission for label text
      // zoom-stops like `step(zoom, .ABBREV, 4, .NAME)`: .ABBREV
      // became `toNumber("China") = NaN` and labels rendered as
      // "NaN" / blank instead of the intended ABBREV / NAME.
      if (args.length === 4 && typeof args[2] !== 'number') {
        const [val, threshold, below, above] = args.map(toNumber)
        return val < threshold ? below : above
      }
      if (args.length >= 4 && args.length % 2 === 0) {
        // Mapbox N-stop. Args: [input, def, stop1, val1, stop2, val2, …]
        const input = toNumber(args[0])
        let result: unknown = args[1]
        for (let i = 2; i + 1 < args.length; i += 2) {
          const stop = toNumber(args[i])
          if (input >= stop) result = args[i + 1]
          else break
        }
        return result
      }
      return null
    }
    // String concatenation — Mapbox `["concat", a, b, …]`. Coerces
    // every arg to its string form (numbers via String(), nulls drop).
    case 'concat': {
      let s = ''
      for (const a of args) {
        if (a === null || a === undefined) continue
        s += typeof a === 'string' ? a : String(a)
      }
      return s
    }
    // Case transforms — Mapbox `["downcase", x]` / `["upcase", x]`.
    // Numeric coercion is undefined in spec; we coerce via String().
    case 'downcase': return String(args[0] ?? '').toLowerCase()
    case 'upcase': return String(args[0] ?? '').toUpperCase()
    case 'typeof': {
      // Mapbox `["typeof", value]` — returns "string" / "number" /
      // "boolean" / "object" / null. JS typeof gives "string" /
      // "number" / "boolean" / "object" / "undefined" / "function" /
      // "symbol" / "bigint". Map null → "null" (Mapbox calls it that
      // for null inputs); collapse the JS-specific kinds.
      const v = args[0]
      if (v === null) return 'null'
      const t = typeof v
      if (t === 'undefined') return 'null'
      if (t === 'bigint') return 'number'
      if (t === 'function' || t === 'symbol') return 'string'
      return t
    }
    case 'slice': {
      // Mapbox `["slice", input, start]` or `["slice", input, start, end]`.
      // Works on strings (substring) and arrays (subarray). Native
      // String#slice / Array#slice handle negative indices (count from
      // end) which Mapbox spec doesn't formally guarantee but most
      // styles assume.
      const input = args[0]
      const start = toNumber(args[1])
      const end = args.length >= 3 ? toNumber(args[2]) : undefined
      if (typeof input === 'string') {
        return end === undefined ? input.slice(start) : input.slice(start, end)
      }
      if (Array.isArray(input)) {
        return end === undefined ? input.slice(start) : input.slice(start, end)
      }
      return null
    }
    case 'index-of':
    case 'index_of': {
      // Mapbox `["index-of", needle, haystack]` or
      // `["index-of", needle, haystack, from_index]`. Returns -1 when
      // not found. The converter emits the underscore form
      // (`index_of`) since the xgis identifier grammar disallows
      // hyphens; both names route here.
      const needle = args[0]
      const haystack = args[1]
      const from = args.length >= 3 ? toNumber(args[2]) : 0
      if (typeof haystack === 'string') {
        return haystack.indexOf(String(needle ?? ''), from)
      }
      if (Array.isArray(haystack)) {
        return haystack.indexOf(needle, from)
      }
      return -1
    }
    case 'number-format':
    case 'number_format': {
      // Two call shapes are accepted:
      //   - Object-options:   number_format(input, { locale, currency,
      //                                              "min-fraction-digits",
      //                                              "max-fraction-digits" })
      //     Direct AST callers (legacy / Mapbox-style synthesis) use this.
      //   - Positional:       number_format(input, minFrac, maxFrac, locale, currency)
      //     The xgis converter emits this form since the parser has no
      //     object-literal syntax. `null` slots mean "spec default".
      const input = toNumber(args[0])
      let minFrac: number | undefined
      let maxFrac: number | undefined
      let locale: string | undefined
      let currency: string | undefined
      const second = args[1]
      if (second && typeof second === 'object' && !Array.isArray(second)) {
        const o = second as Record<string, unknown>
        const mf = o['min-fraction-digits'] ?? o.minFractionDigits
        const xf = o['max-fraction-digits'] ?? o.maxFractionDigits
        if (typeof mf === 'number') minFrac = mf
        if (typeof xf === 'number') maxFrac = xf
        if (typeof o.locale === 'string') locale = o.locale
        if (typeof o.currency === 'string') currency = o.currency
      } else {
        if (typeof second === 'number') minFrac = second
        const a2 = args[2]; if (typeof a2 === 'number') maxFrac = a2
        const a3 = args[3]; if (typeof a3 === 'string') locale = a3
        const a4 = args[4]; if (typeof a4 === 'string') currency = a4
      }
      const intlOpts: Intl.NumberFormatOptions = {}
      if (currency) {
        intlOpts.style = 'currency'
        intlOpts.currency = currency
      }
      if (minFrac !== undefined) intlOpts.minimumFractionDigits = minFrac
      if (maxFrac !== undefined) intlOpts.maximumFractionDigits = maxFrac
      try {
        return new Intl.NumberFormat(locale, intlOpts).format(input)
      } catch {
        return String(input)
      }
    }
    // PI alias — Mapbox `["pi"]` (zero-arg). The existing `PI`
    // builtin used the SCREAMING name; expose lowercase too so the
    // converter can emit a 1:1 name match.
    case 'pi': return Math.PI
    case 'e': return Math.E
    case 'ln2': return Math.LN2
    case 'ln': return Math.log(Math.max(1e-10, toNumber(args[0])))
    case 'interpolate':
    case 'interpolate_exp': {
      // interpolate(input, x1, y1, x2, y2, …) — linear interpolation
      // between (xi, yi) stops.
      // interpolate_exp(input, base, x1, y1, x2, y2, …) — Mapbox
      // `["interpolate", ["exponential", base], …]`; same shape but
      // with an extra leading `base` argument that shapes the
      // between-stops curve. base === 1 is mathematically linear.
      const isExp = name === 'interpolate_exp'
      const minArgs = isExp ? 4 : 3
      if (args.length < minArgs) return null
      let cursor = 0
      const input = toNumber(args[cursor++])
      let base = 1
      if (isExp) base = toNumber(args[cursor++])
      const remaining = args.length - cursor
      if (remaining < 2 || remaining % 2 !== 0) return null
      const stops: Array<{ x: number; y: unknown }> = []
      for (let i = cursor; i + 1 < args.length; i += 2) {
        stops.push({ x: toNumber(args[i]), y: args[i + 1] })
      }
      if (stops.length === 0) return null
      if (input <= stops[0].x) return stops[0].y
      if (input >= stops[stops.length - 1].x) return stops[stops.length - 1].y
      for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i], b = stops[i + 1]
        if (input >= a.x && input <= b.x) {
          if (typeof a.y === 'number' && typeof b.y === 'number') {
            let t: number
            // Guard against duplicate-x stops (a.x === b.x) which
            // would otherwise produce division by zero → Infinity → t
            // NaN-propagates into the final result.
            if (b.x === a.x) {
              t = 0
            } else if (base === 1 || Math.abs(base - 1) < 1e-6) {
              t = (input - a.x) / (b.x - a.x)
            } else {
              const numer = Math.pow(base, input - a.x) - 1
              const denom = Math.pow(base, b.x - a.x) - 1
              t = denom === 0 ? 0 : numer / denom
            }
            if (!Number.isFinite(t)) t = 0
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
    case 'asin': {
      // Math.asin domain [-1, 1] — outside returns NaN. Clamp so the
      // NaN doesn't propagate downstream (consistent with sqrt clamp).
      const x = toNumber(args[0])
      return Math.asin(Math.max(-1, Math.min(1, x)))
    }
    case 'acos': {
      const x = toNumber(args[0])
      return Math.acos(Math.max(-1, Math.min(1, x)))
    }
    case 'atan': return Math.atan(toNumber(args[0]))
    case 'atan2': return Math.atan2(toNumber(args[0]), toNumber(args[1]))
    // Exponential
    case 'pow': {
      // Math.pow(-1, 0.5) = NaN, Math.pow(0, -1) = Infinity. Guard
      // both via non-finite → 0 mirror of c6aa3b0 / 2e6e623.
      const r = Math.pow(toNumber(args[0]), toNumber(args[1]))
      return Number.isFinite(r) ? r : 0
    }
    case 'exp': {
      // Math.exp(very-large) = Infinity. Guard.
      const r = Math.exp(toNumber(args[0]))
      return Number.isFinite(r) ? r : 0
    }
    case 'log': return Math.log(Math.max(1e-10, toNumber(args[0])))
    // Constants
    case 'PI': return Math.PI
    case 'TAU': return Math.PI * 2
    // Array
    case 'length': {
      // Mapbox `["length", v]` works on both strings and arrays.
      // Pre-fix the evaluator only returned the array length and
      // collapsed string inputs to 0 — \`["length", ["get", "name"]]\`
      // returned 0 for every feature.
      const v0 = args[0]
      if (Array.isArray(v0)) return v0.length
      if (typeof v0 === 'string') return [...v0].length  // codepoint count, not UTF-16 units
      return 0
    }
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
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0
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
