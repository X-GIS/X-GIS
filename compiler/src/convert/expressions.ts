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
      return `.${field}`
    }
    case 'has': {
      const field = v[1]
      if (typeof field !== 'string') return null
      return `.${field} != null`
    }
    case '!has': {
      const field = v[1]
      if (typeof field !== 'string') return null
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
