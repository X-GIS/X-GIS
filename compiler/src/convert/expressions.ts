// Mapbox expression / filter → xgis expression conversion.
//
// Handles both spec generations:
//   - Mapbox v1 expression form: `["==", ["get", "field"], "value"]`
//   - Legacy filter form:        `["==", "field", "value"]`
//
// `exprToXgis` is the recursive worker for expression form.
// `filterToXgis` is the wrapper that ALSO accepts legacy filter
// shapes — most callers want this one.

import { parenthesize } from './utils'

/** Mapbox v1 expression → xgis expression string, or null when the
 *  shape isn't recognised. Recursively walks the expression tree;
 *  `warnings` accumulates "this got dropped / approximated" notes. */
export function exprToXgis(v: unknown, warnings: string[]): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return JSON.stringify(v) // quoted string literal
  if (!Array.isArray(v)) return null
  const op = v[0]
  switch (op) {
    case 'literal':
      return exprToXgis(v[1], warnings)
    case 'get': {
      const field = v[1]
      const obj = v[2]
      if (typeof field !== 'string') return null
      if (obj !== undefined) {
        warnings.push(`["get", "${field}", <obj>] with explicit object — converted as plain field access; verify scope.`)
      }
      // xgis FieldAccess only accepts bare identifiers — Mapbox vector-
      // tile properties with `:` (e.g. `name:latin`, `name:nonlatin`)
      // would lex as `<modifier>:` tokens and break the parse. Drop
      // with a warning so the parent expression's fallback (`??`,
      // `case` default) covers the gap. Real-world hit: OpenFreeMap
      // Bright text-field uses `concat(get("name:latin"), " ",
      // get("name:nonlatin"))` for bilingual label rendering.
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
        warnings.push(`["get", "${field}"] non-identifier field — dropped (use a fallback like \`?? get("name")\`).`)
        return null
      }
      return `.${field}`
    }
    case 'has': {
      const field = v[1]
      if (typeof field !== 'string') return null
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
        warnings.push(`["has", "${field}"] non-identifier field — dropped.`)
        return null
      }
      return `.${field} != null`
    }
    case '!has': {
      const field = v[1]
      if (typeof field !== 'string') return null
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
        warnings.push(`["!has", "${field}"] non-identifier field — dropped.`)
        return null
      }
      return `.${field} == null`
    }
    case 'coalesce': {
      const args = v.slice(1).map(a => exprToXgis(a, warnings))
      const valid = args.filter((a): a is string => a !== null)
      if (valid.length === 0) return null
      return valid.join(' ?? ')
    }
    case 'case': {
      // ["case", cond1, val1, cond2, val2, …, default]
      // → cond1 ? val1 : cond2 ? val2 : … : default
      const args = v.slice(1)
      if (args.length < 3 || args.length % 2 === 0) {
        warnings.push(`Malformed ["case"] expression: ${JSON.stringify(v).slice(0, 120)}`)
        return null
      }
      const def = exprToXgis(args[args.length - 1], warnings)
      let result = def ?? '0'
      for (let i = args.length - 3; i >= 0; i -= 2) {
        const cond = exprToXgis(args[i], warnings)
        const val = exprToXgis(args[i + 1], warnings)
        if (cond === null || val === null) continue
        result = `${cond} ? ${val} : ${result}`
      }
      return result
    }
    case 'match': {
      // ["match", input, key1, val1, key2, val2, …, default]
      // → match(.field) { key -> value, _ -> default }
      const input = v[1]
      const args = v.slice(2)
      if (args.length < 1 || args.length % 2 !== 1) {
        warnings.push(`Malformed ["match"] expression: ${JSON.stringify(v).slice(0, 120)}`)
        return null
      }
      const inputXgis = exprToXgis(input, warnings)
      if (inputXgis === null || !inputXgis.startsWith('.')) {
        // X-GIS match() takes a field access; complex inputs fall
        // back to a chained ternary.
        return matchToTernary(input, args, warnings)
      }
      const arms: string[] = []
      const def = args[args.length - 1]
      for (let i = 0; i < args.length - 1; i += 2) {
        const key = args[i]
        const val = exprToXgis(args[i + 1], warnings)
        if (val === null) continue
        const keyStrs = Array.isArray(key) ? key : [key]
        for (const k of keyStrs) {
          arms.push(`    ${typeof k === 'string' ? JSON.stringify(k) : k} -> ${val}`)
        }
      }
      const defXgis = exprToXgis(def, warnings)
      if (defXgis !== null) arms.push(`    _ -> ${defXgis}`)
      return `match(${inputXgis}) {\n${arms.join(',\n')}\n  }`
    }
    case 'all': {
      const parts = v.slice(1).map(a => filterToXgis(a, warnings)).filter((s): s is string => !!s)
      if (parts.length === 0) return 'true'
      return parts.map(parenthesize).join(' && ')
    }
    case 'any': {
      const parts = v.slice(1).map(a => filterToXgis(a, warnings)).filter((s): s is string => !!s)
      if (parts.length === 0) return 'false'
      return parts.map(parenthesize).join(' || ')
    }
    case '!': {
      const inner = filterToXgis(v[1], warnings)
      return inner ? `!(${inner})` : null
    }
    // Comparison / arithmetic operators map identically.
    case '==': case '!=': case '<': case '<=': case '>': case '>=':
    case '+': case '-': case '*': case '/': case '%': {
      if (v.length !== 3) return null
      const a = exprToXgis(v[1], warnings)
      const b = exprToXgis(v[2], warnings)
      if (a === null || b === null) return null
      return `${a} ${op} ${b}`
    }
    case 'min': case 'max': {
      const args = v.slice(1).map(x => exprToXgis(x, warnings)).filter((s): s is string => s !== null)
      return args.length > 0 ? `${op}(${args.join(', ')})` : null
    }
    case 'to-number': case 'number': {
      // X-GIS evaluator coerces in arithmetic; pass through the inner.
      return exprToXgis(v[1], warnings)
    }
    case 'to-string': case 'to-boolean': case 'to-color': {
      // Same coercion-passthrough rationale as `to-number`: X-GIS
      // evaluator coerces by context (text resolver stringifies,
      // boolean ops toBool, color literals are already canonical
      // hex). Dropping the cast wrapper lowers cleanly and the inner
      // expression carries the value.
      return exprToXgis(v[1], warnings)
    }
    // ─── Batch 6: math + trig + log builtins ───
    // All of these have a 1:1 evaluator builtin (callBuiltin in
    // compiler/src/eval/evaluator.ts). The converter just wraps the
    // operands in a function-call shape the parser turns back into a
    // FnCall expression.
    case '^': {
      // Mapbox `["^", a, b]` → xgis `pow(a, b)`. Two args required.
      if (v.length !== 3) return null
      const a = exprToXgis(v[1], warnings)
      const b = exprToXgis(v[2], warnings)
      if (a === null || b === null) return null
      return `pow(${a}, ${b})`
    }
    case 'abs': case 'ceil': case 'floor': case 'round':
    case 'sqrt': case 'sin': case 'cos': case 'tan':
    case 'asin': case 'acos': case 'atan':
    case 'ln': case 'log10': case 'log2':
    case 'length': case 'downcase': case 'upcase': {
      const inner = exprToXgis(v[1], warnings)
      return inner !== null ? `${op}(${inner})` : null
    }
    case 'pi': case 'e': case 'ln2': {
      // Zero-arg constants — Mapbox emits `["pi"]`. The evaluator
      // resolves these as builtin calls with empty arg lists.
      return `${op}()`
    }
    case 'concat': {
      // Mapbox `["concat", a, b, …]` → xgis `concat(a, b, …)`. The
      // evaluator coerces each arg to string with null-skipping
      // semantics that match the Mapbox spec.
      const parts = v.slice(1).map(a => exprToXgis(a, warnings)).filter((s): s is string => s !== null)
      return parts.length > 0 ? `concat(${parts.join(', ')})` : null
    }
    case 'step': {
      // Mapbox `["step", input, default, stop1, val1, stop2, val2, …]`.
      // Total length is always ODD: 1 (op) + 1 (input) + 1 (default)
      // + 2N (N pairs). Min length = 5 (one pair). The evaluator's
      // N-stop step accepts the same positional shape (see
      // eval/evaluator.ts callBuiltin step for the semantics).
      if (v.length < 5 || v.length % 2 !== 1) {
        warnings.push(`Malformed ["step"] expression: ${JSON.stringify(v).slice(0, 120)}`)
        return null
      }
      const args = v.slice(1).map(a => exprToXgis(a, warnings))
      if (args.some(a => a === null)) return null
      return `step(${args.join(', ')})`
    }
    case 'let': {
      // Mapbox `["let", "name1", expr1, "name2", expr2, …, body]`.
      // Strategy: substitute every `["var", "name"]` reference inside
      // body with its bound expression (Mapbox lets are pure, no side
      // effects). We do this BEFORE recursing so the body sees the
      // substituted form. Out of scope: shadowed names from outer
      // lets — Mapbox styles in the wild don't shadow.
      const args = v.slice(1)
      if (args.length < 3 || args.length % 2 === 0) {
        warnings.push(`Malformed ["let"] expression: ${JSON.stringify(v).slice(0, 120)}`)
        return null
      }
      const body = args[args.length - 1]
      const bindings = new Map<string, unknown>()
      for (let i = 0; i < args.length - 1; i += 2) {
        const name = args[i]
        if (typeof name !== 'string') return null
        bindings.set(name, args[i + 1])
      }
      const substituted = substituteVars(body, bindings)
      return exprToXgis(substituted, warnings)
    }
    case 'var': {
      // Bare `["var", "name"]` outside any `let` — invalid per spec.
      // Returning null surfaces it in the generic "Expression not
      // converted" warning at the bottom.
      warnings.push(`["var"] outside ["let"]: ${JSON.stringify(v).slice(0, 80)}`)
      return null
    }
    case 'at': {
      // Mapbox `["at", index, array]` — array indexing. xgis has
      // ArrayAccess via `arr[idx]` syntax (parsed as a postfix).
      if (v.length !== 3) return null
      const idx = exprToXgis(v[1], warnings)
      const arr = exprToXgis(v[2], warnings)
      if (idx === null || arr === null) return null
      return `${arr}[${idx}]`
    }
    case 'typeof': {
      // X-GIS is dynamically typed and doesn't expose a runtime
      // type tag. Drop with a warning so the user knows their style
      // had a typeof check that won't fire.
      warnings.push(`["typeof"] dropped — X-GIS lacks a runtime type accessor.`)
      return null
    }
    case 'rgb': case 'rgba': {
      // Mapbox `["rgb", r, g, b]` / `["rgba", r, g, b, a]` — channel
      // expressions. When all channels are constant numbers we can
      // hex-encode at convert time; otherwise leave as a function
      // call for the evaluator to handle (which it doesn't currently;
      // surfaces as a warning so callers know).
      const ch = v.slice(1)
      const allNumeric = ch.every(c => typeof c === 'number')
      if (allNumeric) {
        const [r, g, b, a] = ch as number[]
        const cl = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
        const hex = (n: number) => cl(n).toString(16).padStart(2, '0')
        return op === 'rgb'
          ? `#${hex(r)}${hex(g)}${hex(b)}`
          : `#${hex(r)}${hex(g)}${hex(b)}${hex(Math.round(a * 255))}`
      }
      warnings.push(`["${op}"] with non-constant channels not converted: ${JSON.stringify(v).slice(0, 80)}`)
      return null
    }
    case 'geometry-type':
    case 'id': {
      // Pseudo-accessors used inside ["==", ["geometry-type"], …].
      // Same rationale as the $type / $id legacy filter case below —
      // dropped sub-expression bubbles `null` through the parent ==/!=.
      warnings.push(`["${op}"] dropped — no xgis feature-meta accessor.`)
      return null
    }
    case 'in': {
      // Two flavours:
      //   expression-form: ["in", value, ["literal", [...]]]
      //   legacy:          ["in", "field", v1, v2, …]
      const field = v[1]
      const list = v[2]
      if (Array.isArray(list) && list[0] === 'literal' && Array.isArray(list[1])) {
        const fxg = typeof field === 'string'
          ? `.${field}`
          : exprToXgis(field, warnings)
        if (fxg === null) return null
        const eqs = list[1].map((k: unknown) => `${fxg} == ${typeof k === 'string' ? JSON.stringify(k) : k}`)
        return eqs.join(' || ')
      }
      if (typeof field === 'string') {
        const eqs = v.slice(2).map(k => `.${field} == ${typeof k === 'string' ? JSON.stringify(k) : k}`)
        return eqs.join(' || ')
      }
      warnings.push(`["in"] form not converted: ${JSON.stringify(v).slice(0, 120)}`)
      return null
    }
  }
  warnings.push(`Expression not converted: ${JSON.stringify(v).slice(0, 120)}`)
  return null
}

/** Recursively replace `["var", "name"]` nodes with their bound
 *  expression. Used by the `let` lowering — Mapbox lets are pure,
 *  so substitution is semantically equivalent to a runtime scope
 *  lookup and lets the rest of the converter walk a flat tree. */
function substituteVars(expr: unknown, bindings: Map<string, unknown>): unknown {
  if (!Array.isArray(expr)) return expr
  if (expr[0] === 'var' && typeof expr[1] === 'string') {
    return bindings.has(expr[1]) ? bindings.get(expr[1]) : expr
  }
  // Don't recurse into nested `let`s — their inner `var` references
  // belong to the inner scope. A heuristic, but matches the way
  // Mapbox styles in the wild are written (no shadowing).
  if (expr[0] === 'let') return expr
  return expr.map(c => substituteVars(c, bindings))
}

/** Lower `["match", input, k1, val1, …, default]` to a boolean
 *  expression when every val (and the default) is a boolean literal.
 *  Returns null when the match is value-typed (caller should keep it
 *  as match()).
 *
 *  Standard Mapbox idiom: `["match", input, [keys...], true, false]`
 *  meaning "input is one of these keys". xgis filter context wants a
 *  plain boolean expression, not match() (which is a value-mapping
 *  form), so we fan out into an OR/AND chain. */
export function matchToBooleanFilter(v: unknown[], warnings: string[]): string | null {
  if (v[0] !== 'match' || v.length < 4) return null
  const input = v[1]
  const args = v.slice(2)
  if (args.length % 2 !== 1) return null
  const def = args[args.length - 1]

  // All values + default must be boolean literals.
  const allBool = (() => {
    if (typeof def !== 'boolean') return false
    for (let i = 1; i < args.length - 1; i += 2) {
      if (typeof args[i] !== 'boolean') return false
    }
    return true
  })()
  if (!allBool) return null

  const inputXgis = exprToXgis(input, warnings)
  if (inputXgis === null) return null

  // Polarity: default `false` → OR of equality for true-arms.
  // Default `true` → AND of inequality for false-arms (the "not in
  // <keys>" form).
  const polarity = def === false
  const eqOp = polarity ? '==' : '!='
  const join = polarity ? ' || ' : ' && '
  const targetVal = polarity

  const parts: string[] = []
  for (let i = 0; i < args.length - 1; i += 2) {
    const key = args[i]
    const val = args[i + 1]
    if (val !== targetVal) continue
    const keys = Array.isArray(key) ? key : [key]
    for (const k of keys) {
      parts.push(`${inputXgis} ${eqOp} ${typeof k === 'string' ? JSON.stringify(k) : k}`)
    }
  }
  if (parts.length === 0) {
    // No matching arms — match collapses to the default literal.
    return String(def)
  }
  return parts.join(join)
}

/** Used when `["match", <complex>, …]` can't go through xgis match()
 *  because match() requires a field-access input. Falls back to a
 *  chain of `input == key ? value : …`. Less efficient but always
 *  expressible. */
export function matchToTernary(input: unknown, args: unknown[], warnings: string[]): string | null {
  const inputXgis = exprToXgis(input, warnings)
  if (inputXgis === null) return null
  const def = exprToXgis(args[args.length - 1], warnings) ?? '0'
  let result = def
  for (let i = args.length - 3; i >= 0; i -= 2) {
    const key = args[i]
    const val = exprToXgis(args[i + 1], warnings)
    if (val === null) continue
    const keyStrs = Array.isArray(key) ? key : [key]
    const cond = keyStrs.map(k => `${inputXgis} == ${typeof k === 'string' ? JSON.stringify(k) : k}`).join(' || ')
    result = `(${cond}) ? ${val} : ${result}`
  }
  return result
}

/** Filter expression → xgis filter string. Accepts both the v1
 *  expression form (which routes through `exprToXgis`) AND the
 *  legacy filter form (`["==", "field", "value"]` with the field
 *  as a bare string in position 1). */
export function filterToXgis(v: unknown, warnings: string[]): string | null {
  if (v === null || v === undefined) return null
  if (!Array.isArray(v)) return exprToXgis(v, warnings)
  const op = v[0]

  // Mapbox pseudo-fields ($type, $id) have no xgis equivalent. $type
  // is redundant — layer geometry type is already encoded by which
  // utility class (fill- / stroke- / shape-) the layer uses — so we
  // drop the sub-predicate. $id has no accessor; user has to swap in
  // a real `.field` check after the fact.
  if ((op === '==' || op === '!=' || op === 'in' || op === '!in') &&
      (v[1] === '$type' || v[1] === '$id')) {
    warnings.push(`Filter on "${v[1]}" dropped — no xgis equivalent (geometry type is implied by the layer's utility class).`)
    return null
  }

  // Boolean-returning ["match", input, k1, true, k2, true, …, false]
  // is the standard "input is one of these keys" idiom. xgis filter
  // context wants a plain boolean expression, so lower to OR/AND.
  if (op === 'match') {
    const lowered = matchToBooleanFilter(v, warnings)
    if (lowered !== null) return lowered
    // Fall through to exprToXgis for non-boolean match — user sees
    // the "Malformed match" or "Expression not converted" warning
    // either way.
  }

  // Legacy filter syntax (Mapbox GL JS v0.x / v1.x style spec): the
  // FIELD is the second element, not an ["get", "field"] sub-expr.
  if ((op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') &&
      typeof v[1] === 'string' && !Array.isArray(v[2])) {
    const field = v[1]
    const val = v[2]
    return `.${field} ${op} ${typeof val === 'string' ? JSON.stringify(val) : val}`
  }
  // Legacy `!in` — Mapbox v0/v1 style spec.
  if (op === '!in' && typeof v[1] === 'string') {
    const field = v[1]
    const eqs = v.slice(2).map(k => `.${field} != ${typeof k === 'string' ? JSON.stringify(k) : k}`)
    return eqs.join(' && ')
  }
  // Otherwise route through the expression converter — it covers
  // all (non-legacy) forms uniformly.
  return exprToXgis(v, warnings)
}
