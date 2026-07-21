// Mapbox expression / filter → xgis expression conversion.
//
// Handles both spec generations:
//   - Mapbox v1 expression form: `["==", ["get", "field"], "value"]`
//   - Legacy filter form:        `["==", "field", "value"]`
//
// `exprToXgis` is the recursive worker for expression form.
// `filterToXgis` is the wrapper that ALSO accepts legacy filter
// shapes — most callers want this one.

import { matchToBooleanFilter } from './expr-match'
import { EXPR_HANDLERS } from './expr-registry'

/** Maximum nesting depth before the expression converter bails. A
 *  pathological style with 1e4+ levels of nesting (case-inside-case
 *  chains, recursive let bodies, …) could blow the V8 stack pre-fix —
 *  256 is far above any realistic style spec (OFM Bright peaks at
 *  ~12 levels) but well below the 10k+ frames where browsers start
 *  to fail. The guard prevents a malformed style from crashing the
 *  whole compile; a single subtree is dropped with a warning. */
const MAX_EXPR_DEPTH = 256
let _exprDepth = 0

/** Mapbox v1 expression → xgis expression string, or null when the
 *  shape isn't recognised. Recursively walks the expression tree;
 *  `warnings` accumulates "this got dropped / approximated" notes.
 *  Re-entrant via the module-scoped `_exprDepth` counter — every
 *  inner recursive call advances depth + decrements in `finally`. */
export function exprToXgis(v: unknown, warnings: string[]): string | null {
  if (_exprDepth >= MAX_EXPR_DEPTH) {
    if (_exprDepth === MAX_EXPR_DEPTH) {
      warnings.push(`Expression nesting depth exceeded ${MAX_EXPR_DEPTH}; subtree truncated.`)
    }
    return null
  }
  _exprDepth++
  try {
    return _exprToXgisImpl(v, warnings)
  } finally {
    _exprDepth--
  }
}

function _exprToXgisImpl(v: unknown, warnings: string[]): string | null {
  // Explicit `null` → emit the xgis `null` identifier. Mapbox styles
  // use `[\"==\", [\"get\", \"field\"], null]` to test for missing
  // properties; pre-fix this collapsed the whole comparison to the
  // "not converted" branch and the predicate dropped silently.
  // Evaluator: `null` lowers as Identifier(name='null'); `props['null']`
  // is virtually never set, so `props['null'] ?? null` → null, then
  // `===` matches a missing-field null. Real properties literally
  // named 'null' would shadow this — acceptable trade-off (no observed
  // styles do this).
  if (v === null) return 'null'
  if (v === undefined) return null
  if (typeof v === 'number') {
    // Reject NaN / Infinity at the scalar emitter — `String(NaN)` →
    // "NaN" landed verbatim in emitted xgis (e.g. inside
    // `interpolate(zoom, 5, NaN, 10, 3)`), the parser tokenized the
    // bare identifier "NaN" and the whole expression silently
    // dropped to undefined at evaluation time. Mirror of the
    // paint-side addOpacity / addStrokeWidth NaN guards.
    if (!Number.isFinite(v)) {
      warnings.push(
        `Non-finite numeric literal (${String(v)}) dropped — emit would be invalid xgis bare identifier.`,
      )
      return null
    }
    return String(v)
  }
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return JSON.stringify(v) // quoted string literal
  if (!Array.isArray(v)) return null
  const op = v[0]
  if (typeof op === 'string') {
    const handler = EXPR_HANDLERS.get(op)
    if (handler !== undefined) {
      // Each handler is the verbatim body of the original `switch(op)`
      // arm; it recurses through the public `exprToXgis` (and, for the
      // logic cluster, `filterToXgis`) so the central depth guard still
      // applies on every nested call.
      return handler(v, warnings, exprToXgis, filterToXgis, op)
    }
  }
  // Mapbox-specific accessors with dedicated runtime support pending:
  // surface a precise message instead of the generic "Expression not
  // converted" catch-all so the user sees the gap is feature-specific
  // (heatmap pipeline, line-gradient, feature-state, etc.) not a
  // generic shape problem.
  const unsupportedOp = (v as unknown[])[0]
  if (typeof unsupportedOp === 'string') {
    const KNOWN_UNSUPPORTED: Record<string, string> = {
      'heatmap-density':
        'Heatmap density accessor — only meaningful inside a heatmap-color ramp, which the heatmap converter lowers separately (layers-heatmap.ts heatmapRampToXgis); it has no value in a generic expression context.',
      'line-progress':
        'Line-progress accessor — line-gradient requires source.lineMetrics + a per-fragment progress varying; not yet implemented.',
      'sky-radial-progress': 'Sky-radial-progress accessor — sky layer rendering not implemented.',
      accumulated:
        'Accumulated accessor — clusterProperties pipeline not implemented (clustering is host-side today).',
      'distance-from-center':
        'Distance-from-center accessor — globe-mode runtime queries not wired through to filter eval yet.',
      // `pitch` is now SUPPORTED — handled by the `case 'pitch'` arm
      // above (returns the bare `pitch` identifier), so it never reaches
      // this fallback table.
      'feature-state':
        'Feature-state accessor — map.setFeatureState() / hover-state is not yet implemented; values resolve to null.',
      // `image` is now SUPPORTED in BOTH contexts — the icon-image PROPERTY
      // strips the `["image", …]` wrapper (unwrapImageExpr, #777 I2) and a
      // TEXT/format inline image lowers to the `image(name)` builtin
      // (imageHandler, #777 I-G) → an inline sprite quad on the baseline.
      // Neither reaches this fallback table.
      // `within` is now SUPPORTED (Point/MultiPoint vs Polygon/MultiPolygon
      // on GeoJSON sources) — handled by withinHandler in the expr-lookup
      // cluster, so it never reaches this fallback table. (LineString /
      // Polygon tested-geometry and MVT tile-coordinate sources remain
      // partial — see eval/within.ts.)
      // `is-supported-script` is now SUPPORTED — handled by
      // isSupportedScriptHandler in the expr-lookup cluster (lowers to
      // constant `true`, matching X-GIS' all-Unicode-renderable
      // capability), so it never reaches this fallback table.
      // `resolved-locale` is now SUPPORTED (constant collator locale) —
      // handled by resolvedLocaleHandler in the expr-lookup cluster, so it
      // never reaches this fallback table.
      // `collator` as the trailing 4th arg of a comparison op IS now
      // supported (lowers to the `collator_cmp` CPU builtin — see
      // comparisonHandler). A STANDALONE `["collator", …]` (not attached to
      // a comparison) has no value in X-GIS and still warns here.
      collator:
        'collator object used outside a comparison operator — a bare ["collator", …] has no standalone value; attach it as the 4th argument of ==/!=/</<=/>/>= for locale-aware compare.',
      // Iter 544 additions — Mapbox spec ops the converter dropped to
      // the generic "Expression not converted" catch-all. Specific
      // messages so the lossy report surfaces the actual feature gap.
      // (`properties` is now SUPPORTED — handled by propertiesHandler in
      // the expr-lookup cluster, emits the `properties()` builtin, so it
      // never reaches this fallback table.)
      // `distance` is now SUPPORTED (Point/MultiPoint feature-geometry vs
      // any target, GeoJSON sources) — handled by distanceHandler in the
      // expr-lookup cluster, so it never reaches this fallback table.
      // (LineString/Polygon feature-geometry and MVT sources remain
      // partial — see eval/distance.ts.)
    }
    const reason = KNOWN_UNSUPPORTED[unsupportedOp]
    if (reason !== undefined) {
      warnings.push(`["${unsupportedOp}"] not yet supported: ${reason}`)
      return null
    }
  }
  warnings.push(`Expression not converted: ${JSON.stringify(v).slice(0, 120)}`)
  return null
}

/** Filter expression → xgis filter string. Accepts both the v1
 *  expression form (which routes through `exprToXgis`) AND the
 *  legacy filter form (`["==", "field", "value"]` with the field
 *  as a bare string in position 1). */
export function filterToXgis(v: unknown, warnings: string[]): string | null {
  if (v === null || v === undefined) return null
  // Peel multi-wrap null: `["literal", null]` / deeper means "no
  // filter" per Mapbox spec (a null filter accepts every feature).
  // Pre-fix the wrapped form fell through to exprToXgis which
  // emitted the bare 'null' identifier — runtime then evaluated the
  // filter to null, toBool(null) = false, EVERY feature dropped, and
  // the layer rendered empty.
  let peeled: unknown = v
  while (Array.isArray(peeled) && peeled.length === 2 && peeled[0] === 'literal') {
    peeled = peeled[1]
  }
  if (peeled === null || peeled === undefined) return null
  if (!Array.isArray(v)) return exprToXgis(v, warnings)
  const op = v[0]

  // Mapbox pseudo-fields ($type, $id) in the legacy filter form are
  // routed to the existing expression-form accessors:
  //   $type  →  ["geometry-type"]  →  get("$geometryType")
  //   $id    →  ["id"]             →  get("$featureId")
  // Both accessors are already supported (expressions.ts:822, :840).
  // Pre-fix these were dropped with a warning. Now we rewrite the
  // array in-place so the comparison/in/!in paths downstream handle
  // the accessor just like any other expression operand.
  // Peel wrapped pseudo-field name (mirror of legacy comparison fix
  // 8013bc3) — ['==', ['literal', '$type'], 'Polygon'] should still
  // be recognised as a pseudo-field rewrite, not fall to a literal-
  // vs-literal compare.
  let peeledPseudoField: unknown = v[1]
  while (
    Array.isArray(peeledPseudoField) &&
    peeledPseudoField.length === 2 &&
    peeledPseudoField[0] === 'literal'
  ) {
    peeledPseudoField = peeledPseudoField[1]
  }
  if (
    (op === '==' || op === '!=' || op === 'in' || op === '!in') &&
    (peeledPseudoField === '$type' || peeledPseudoField === '$id')
  ) {
    const accessorExpr = peeledPseudoField === '$type' ? ['geometry-type'] : ['id']
    const accessorStr = peeledPseudoField === '$type' ? 'get("$geometryType")' : 'get("$featureId")'
    if (op === '==' || op === '!=') {
      // Scalar comparison: rewrite v[1] to the accessor expr and fall
      // through to the expression-form comparison handler below.
      const rewritten = [op, accessorExpr, ...v.slice(2)]
      return exprToXgis(rewritten, warnings)
    }
    // Legacy in / !in multi-value form: ["in", "$type", "Point", "LineString"]
    // Expand to equality OR / AND chain over the accessor.
    const keys = v.slice(2)
    if (keys.length === 0) return op === 'in' ? 'false' : 'true'
    const eqOp = op === 'in' ? '==' : '!='
    const joiner = op === 'in' ? ' || ' : ' && '
    const parts: string[] = []
    for (const k of keys) {
      const kStr =
        typeof k === 'string'
          ? JSON.stringify(k)
          : typeof k === 'number' || typeof k === 'boolean'
            ? String(k)
            : null
      if (kStr === null) {
        warnings.push(
          `["${op}"] with "${peeledPseudoField}" dropped a key that is not a literal string/number/boolean: ${JSON.stringify(k).slice(0, 60)}`,
        )
        continue
      }
      parts.push(`${accessorStr} ${eqOp} ${kStr}`)
    }
    if (parts.length === 0) return op === 'in' ? 'false' : 'true'
    return parts.join(joiner)
  }

  // Boolean-returning ["match", input, k1, true, k2, true, …, false]
  // is the standard "input is one of these keys" idiom. xgis filter
  // context wants a plain boolean expression, so lower to OR/AND.
  if (op === 'match') {
    const lowered = matchToBooleanFilter(v, warnings, exprToXgis)
    if (lowered !== null) return lowered
    // Fall through to exprToXgis for non-boolean match — user sees
    // the "Malformed match" or "Expression not converted" warning
    // either way.
  }

  // Legacy filter syntax (Mapbox GL JS v0.x / v1.x style spec): the
  // FIELD is the second element, not an ["get", "field"] sub-expr.
  // Unwrap v8 strict `["literal", v]` on the value arg before the
  // is-array gate so the legacy `[\"==\", \"kind\", [\"literal\", \"park\"]]`
  // shape still hits the bare-value fast path. Pre-fix the wrapper
  // pushed the value through to exprToXgis which emitted
  // \`\"kind\" == \"park\"\` (literal-vs-literal), always false.
  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    // Peel wrapped field name too: v8 strict tooling occasionally emits
    // `["==", ["literal", "kind"], "park"]` even for legacy-shape
    // comparisons. Pre-fix the wrapped form fell to exprToXgis case
    // 'literal' which emitted the field as a quoted string ('"kind"')
    // and the predicate became `"kind" == "park"` (always false).
    let rawField: unknown = v[1]
    while (Array.isArray(rawField) && rawField.length === 2 && rawField[0] === 'literal') {
      rawField = rawField[1]
    }
    if (typeof rawField === 'string') {
      let rawVal = v[2]
      while (Array.isArray(rawVal) && rawVal.length === 2 && rawVal[0] === 'literal') {
        rawVal = rawVal[1]
      }
      if (!Array.isArray(rawVal)) {
        const field = rawField
        return `.${field} ${op} ${typeof rawVal === 'string' ? JSON.stringify(rawVal) : rawVal}`
      }
    }
  }
  // Legacy `!in` — Mapbox v0/v1 style spec. Per-key unwrap mirrors
  // the `in` op handling — v8 strict tooling can wrap each value
  // (`["literal", "park"]`) and pre-fix the equality emit
  // JSON.stringify'd the wrapper.
  if (op === '!in') {
    // Peel wrapped field name (mirror of the legacy comparison fix
    // 8013bc3). Pre-fix typeof v[1] === 'string' rejected
    // ['!in', ['literal', 'kind'], 'park'] and the predicate fell to
    // exprToXgis which emitted a literal-vs-literal comparison.
    let rawField: unknown = v[1]
    while (Array.isArray(rawField) && rawField.length === 2 && rawField[0] === 'literal') {
      rawField = rawField[1]
    }
    if (typeof rawField === 'string') {
      // Empty values list — `["!in", field]` (no keys) means "field is
      // never in this empty set" → ALWAYS true (always matches). Mirror
      // of the `in` empty-list → false handling.
      if (v.length === 2) return 'true'
      const field = rawField
      const eqs = v.slice(2).map((k) => {
        while (Array.isArray(k) && k.length === 2 && k[0] === 'literal') k = k[1]
        return `.${field} != ${typeof k === 'string' ? JSON.stringify(k) : k}`
      })
      return eqs.join(' && ')
    }
  }
  // Otherwise route through the expression converter — it covers
  // all (non-legacy) forms uniformly.
  return exprToXgis(v, warnings)
}
