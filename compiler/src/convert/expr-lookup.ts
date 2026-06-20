// Property / feature-accessor expression cluster → xgis.
//
// Extracted verbatim from expressions.ts's `_exprToXgisImpl` switch:
// the get / has / !has / at / typeof / in property-access arms plus the
// zero-arg feature accessors (zoom / pitch / geometry-type / id). Each
// handler is the byte-identical body of its original switch arm — the
// only change is the `case`/`return` shape became a function. Recursion
// is taken as a parameter (`recurse`) to avoid importing expressions.ts.

import type { ExprHandler } from './expr-handler-types'

export const getHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox spec: ["get", key] or ["get", key, object]. The field
  // arg is required — `["get"]` would silently drop via
  // exprToXgis(undefined) → null. Warn before bailing so the user
  // sees the malformed call.
  if (v.length < 2) {
    warnings.push(`Malformed ["get"] expression: missing field name argument.`)
    return null
  }
  const field = v[1]
  const obj = v[2]
  if (obj !== undefined) {
    const fieldStr = typeof field === 'string' ? field : JSON.stringify(field).slice(0, 60)
    warnings.push(`["get", "${fieldStr}", <obj>] with explicit object — converted as plain field access; verify scope.`)
  }
  // Mapbox v8 wraps the constant string in `["literal", "name"]`.
  // Unwrap eagerly so the identifier-shape detection below still
  // fires on the inner string.
  let f = field
  // Loop peel for multi-level wraps. Drop the inner === 'string'
  // gate so a doubly-wrapped name like ['literal', ['literal', 'x']]
  // also peels down to the bare string and hits the readable bare-
  // field-access path below (instead of falling to the dynamic-
  // key get("x") path, which still works but obscures the AST).
  while (Array.isArray(f) && f.length === 2 && f[0] === 'literal') {
    f = f[1]
  }
  if (typeof f === 'string') {
    // Identifier-shaped key → bare field access for readability.
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f)) return `.${f}`
    // Mapbox locale variants (`name:latin`, `name:nonlatin`,
    // `name:ko`, …) carry `:` which xgis FieldAccess can't lex.
    // Emit a `get("…")` builtin call — the evaluator special-cases
    // this AST shape (eval/evaluator.ts) so the literal key passes
    // straight through to props[key], preserving the locale
    // semantics that international basemaps depend on.
    return `get(${JSON.stringify(f)})`
  }
  // Dynamic key — the field arg is itself an expression
  // (`["get", ["concat", "name:", ["get", "lang"]]]`). The
  // evaluator's `get(...)` builtin special-cases the case where
  // args[0] evaluates to a string and uses it as the prop key
  // (evaluator.ts:200-202). Pre-fix the converter bailed at the
  // `typeof field !== 'string'` gate and the whole property
  // dropped to null — locale-aware basemaps that pick `name:<lang>`
  // dynamically lost every label.
  const inner = recurse(field, warnings)
  if (inner === null) return null
  return `get(${inner})`
}

export const hasHandler: ExprHandler = (v, warnings, recurse) => {
  // Same v8 literal-wrap + dynamic-key shape as `get`. Pre-fix
  // bailed on non-string field, so `["has", ["concat", "name:",
  // ["get", "lang"]]]` collapsed to null and the filter dropped
  // every feature regardless of presence.
  if (v.length < 2) {
    warnings.push(`Malformed ["has"] expression: missing field name argument.`)
    return null
  }
  let field: unknown = v[1]
  while (Array.isArray(field) && field.length === 2 && field[0] === 'literal') {
    field = field[1]
  }
  if (typeof field === 'string') {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return `.${field} != null`
    // Colon-bearing locale keys round-trip through get("…") which
    // already returns null on miss (matching Mapbox's "has" sense).
    return `get(${JSON.stringify(field)}) != null`
  }
  const inner = recurse(v[1], warnings)
  if (inner === null) return null
  return `get(${inner}) != null`
}

export const notHasHandler: ExprHandler = (v, warnings, recurse) => {
  // Mirror of the `has` dynamic-key fix.
  if (v.length < 2) {
    warnings.push(`Malformed ["!has"] expression: missing field name argument.`)
    return null
  }
  let field: unknown = v[1]
  while (Array.isArray(field) && field.length === 2 && field[0] === 'literal') {
    field = field[1]
  }
  if (typeof field === 'string') {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return `.${field} == null`
    return `get(${JSON.stringify(field)}) == null`
  }
  const inner = recurse(v[1], warnings)
  if (inner === null) return null
  return `get(${inner}) == null`
}

export const atHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox `["at", index, array]` — array indexing. xgis has
  // ArrayAccess via `arr[idx]` syntax (parsed as a postfix).
  if (v.length !== 3) {
    warnings.push(`Malformed ["at"] expression: expected 2 arguments (index, array), got ${v.length - 1}.`)
    return null
  }
  const idx = recurse(v[1], warnings)
  const arr = recurse(v[2], warnings)
  if (idx === null || arr === null) return null
  return `${arr}[${idx}]`
}

export const typeofHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox `["typeof", value]` → xgis `typeof(value)`. The
  // evaluator returns "string" / "number" / "boolean" / "object" /
  // "null" matching the Mapbox spec.
  if (v.length !== 2) {
    warnings.push(`Malformed ["typeof"] expression: expected 1 argument, got ${v.length - 1}.`)
    return null
  }
  const inner = recurse(v[1], warnings)
  return inner !== null ? `typeof(${inner})` : null
}

export const zoomHandler: ExprHandler = (v, warnings) => {
  // Mapbox `["zoom"]` accessor → xgis bare `zoom` identifier.
  // The evaluator special-cases the name (eval/evaluator.ts:40)
  // to read `props[CAMERA_ZOOM_KEY]`, so the dedicated zoom-stops
  // path in paint.ts AND this generic exprToXgis route both
  // resolve to the same live camera zoom at evaluation time.
  // Pre-fix `["zoom"]` outside the dedicated path (e.g. nested
  // inside a `case` / `match` arm) fell to "Expression not
  // converted" and the containing expression dropped silently.
  // Zero-arg accessor — surface extra args so the user notices
  // a malformed `["zoom", 1]` instead of having the operand
  // silently dropped.
  if (v.length !== 1) {
    warnings.push(`Malformed ["zoom"] expression: zero-arg accessor takes no arguments, got ${v.length - 1}.`)
  }
  return 'zoom'
}

export const pitchHandler: ExprHandler = (v, warnings) => {
  // Mapbox `["pitch"]` accessor → xgis bare `pitch` identifier.
  // The evaluator special-cases the name (eval/evaluator.ts) to read
  // `props[CAMERA_PITCH_KEY]`, so this resolves to the live camera
  // pitch (degrees) at evaluation time — mirror of the `["zoom"]`
  // path above. Render-path eval sites (filter / paint) inject it;
  // worker / tile-decode sites leave it null (no camera).
  if (v.length !== 1) {
    warnings.push(`Malformed ["pitch"] expression: zero-arg accessor takes no arguments, got ${v.length - 1}.`)
  }
  return 'pitch'
}

export const geometryTypeHandler: ExprHandler = (v, warnings) => {
  // Mapbox ["geometry-type"] resolves to "Point" / "LineString" /
  // "Polygon" (or their Multi* variants) per feature. xgis has no
  // dedicated geometry-type keyword, so we route through the
  // synthetic property `$geometryType` which the runtime filter
  // path injects from `feature.geometry.type` at evaluation time.
  // Dropping the accessor (the historical behaviour) silently
  // collapsed filters like `["match", ["geometry-type"], …]` into
  // null, which the parent filterToXgis then turned into "no
  // filter" — so a water_name_line_label layer (LineString-only
  // intent) iterated EVERY water_name feature, doubling up with
  // the sibling Point layer on shared OMT centroids near the
  // antimeridian.
  if (v.length !== 1) {
    warnings.push(`Malformed ["geometry-type"] expression: zero-arg accessor takes no arguments, got ${v.length - 1}.`)
  }
  return 'get("$geometryType")'
}

export const idHandler: ExprHandler = (v, warnings) => {
  // Mapbox ["id"] resolves to feature.id (GeoJSON RFC 7946 §3.2;
  // MVT feature.id from the protobuf). Same routing pattern as
  // ["geometry-type"] — the runtime filter-eval sites inject
  // `$featureId` into the props bag at evaluation time so the
  // ["==", ["id"], 42] / ["match", ["id"], …] filters work.
  if (v.length !== 1) {
    warnings.push(`Malformed ["id"] expression: zero-arg accessor takes no arguments, got ${v.length - 1}.`)
  }
  return 'get("$featureId")'
}

export const inHandler: ExprHandler = (v, warnings, recurse) => {
  // Two flavours:
  //   expression-form: ["in", value, ["literal", [...]]]
  //   legacy:          ["in", "field", v1, v2, …]
  // Peel wrapped field name (legacy form) mirror of the legacy
  // comparison fix 8013bc3.
  let field: unknown = v[1]
  while (Array.isArray(field) && field.length === 2 && field[0] === 'literal'
      && typeof field[1] === 'string') {
    field = field[1]
  }
  let list = v[2]
  // Loop peel for multi-level wraps so doubly-wrapped lists
  // (`["literal", ["literal", [...]]]`) from preprocessor chains
  // still hit the expression-form path. Mirror of colorToXgis
  // loop unwrap (921d5ad).
  while (Array.isArray(list) && list.length === 2 && list[0] === 'literal'
      && Array.isArray(list[1]) && list[1][0] === 'literal') {
    list = list[1]
  }
  if (Array.isArray(list) && list[0] === 'literal' && Array.isArray(list[1])) {
    const fxg = typeof field === 'string'
      ? `.${field}`
      : recurse(field, warnings)
    if (fxg === null) return null
    // Empty values list — `["in", x, ["literal", []]]` means "x
    // is never in this set" per Mapbox spec → constant `false`.
    // Pre-fix `eqs.join('||')` on an empty array returned '' and
    // the surrounding filter parser failed on the blank predicate.
    if (list[1].length === 0) return 'false'
    // Each key in the values list can itself be v8-literal-wrapped
    // (Mapbox strict tooling: `["literal", [["literal", "a"], "b"]]`).
    // Unwrap eagerly so the equality emit sees the bare value.
    // Mapbox spec strict: keys MUST be literal scalars (string,
    // number, boolean). Expression-form keys can't be enumerated
    // as `field == k` equalities; surface the constraint instead
    // of silently emitting `[object Object]`.
    let invalidKeys = 0
    const eqs: string[] = []
    for (let k of list[1]) {
      while (Array.isArray(k) && k.length === 2 && k[0] === 'literal') k = k[1]
      if (typeof k !== 'string' && typeof k !== 'number' && typeof k !== 'boolean') {
        invalidKeys++
        continue
      }
      eqs.push(`${fxg} == ${typeof k === 'string' ? JSON.stringify(k) : k}`)
    }
    if (invalidKeys > 0) {
      warnings.push(`["in"] dropped ${invalidKeys} key(s) that are not literal string/number/boolean; Mapbox spec requires literal keys.`)
    }
    if (eqs.length === 0) return 'false'
    return eqs.join(' || ')
  }
  if (typeof field === 'string') {
    // Same empty-list contract for the legacy form.
    if (v.length === 2) return 'false'
    let invalidKeysLegacy = 0
    const eqsLegacy: string[] = []
    for (let k of v.slice(2)) {
      while (Array.isArray(k) && k.length === 2 && k[0] === 'literal') k = k[1]
      if (typeof k !== 'string' && typeof k !== 'number' && typeof k !== 'boolean') {
        invalidKeysLegacy++
        continue
      }
      eqsLegacy.push(`.${field} == ${typeof k === 'string' ? JSON.stringify(k) : k}`)
    }
    if (invalidKeysLegacy > 0) {
      warnings.push(`["in"] (legacy form) dropped ${invalidKeysLegacy} key(s) that are not literal string/number/boolean.`)
    }
    if (eqsLegacy.length === 0) return 'false'
    return eqsLegacy.join(' || ')
  }
  warnings.push(`["in"] form not converted: ${JSON.stringify(v).slice(0, 120)}`)
  return null
}
