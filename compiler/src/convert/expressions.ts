// Mapbox expression / filter → xgis expression conversion.
//
// Handles both spec generations:
//   - Mapbox v1 expression form: `["==", ["get", "field"], "value"]`
//   - Legacy filter form:        `["==", "field", "value"]`
//
// `exprToXgis` is the recursive worker for expression form.
// `filterToXgis` is the wrapper that ALSO accepts legacy filter
// shapes — most callers want this one.

import { parenthesize, parenthesizeTernary } from './utils'
import { substituteVars } from './expressions-helpers'
import { convertInterpolate } from './expr-interpolate'
import { convertMatch, matchToBooleanFilter } from './expr-match'

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
      warnings.push(`Non-finite numeric literal (${String(v)}) dropped — emit would be invalid xgis bare identifier.`)
      return null
    }
    return String(v)
  }
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return JSON.stringify(v) // quoted string literal
  if (!Array.isArray(v)) return null
  const op = v[0]
  switch (op) {
    case 'literal': {
      // Mapbox `["literal", value]` wraps a constant so the inner
      // value isn't re-interpreted as an expression. Scalars (number /
      // boolean / string) round-trip through the scalar-emitter
      // recursion. Inner ARRAYS (`["literal", [1, 2, 3]]`) are the
      // pattern Mapbox styles use to emit constant arrays — e.g.
      // `["at", 0, ["literal", [1, 2, 3]]]`, `["match", x, "a",
      // ["literal", [1,2,3]], default]`, dash arrays via
      // `["literal", [4, 2]]` inside a non-paint context. The
      // generic exprToXgis recursion fell through to "Expression
      // not converted" because a bare `[1, 2, 3]` has no operator
      // string. Emit an xgis array literal instead so the evaluator
      // sees a real array at runtime.
      // Spec: ["literal", value] requires exactly one inner value.
      // A bare ["literal"] (no payload) used to silently bail via
      // exprToXgis(undefined) → null at the bottom.
      if (v.length < 2) {
        warnings.push(`Malformed ["literal"] expression: missing inner value.`)
        return null
      }
      let inner = v[1]
      // Loop peel multi-level wraps: `["literal", ["literal", v]]` is
      // emitted by some v8 strict preprocessor chains. Pre-fix the
      // inner literal-wrap was treated as a 2-element array literal —
      // the converter emitted `["literal", 5]` as an xgis array of
      // ["literal", 5], which the evaluator stored as a real 2-elt
      // array, breaking downstream consumers expecting the scalar.
      // Mirror of colorToXgis's loop unwrap (921d5ad).
      while (Array.isArray(inner) && inner.length === 2 && inner[0] === 'literal') {
        inner = inner[1]
      }
      if (Array.isArray(inner)) {
        const parts: string[] = []
        for (const el of inner) {
          const sub = exprToXgis(el, warnings)
          if (sub === null) return null
          parts.push(sub)
        }
        return `[${parts.join(', ')}]`
      }
      return exprToXgis(inner, warnings)
    }
    case 'get': {
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
      const inner = exprToXgis(field, warnings)
      if (inner === null) return null
      return `get(${inner})`
    }
    case 'has': {
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
      const inner = exprToXgis(v[1], warnings)
      if (inner === null) return null
      return `get(${inner}) != null`
    }
    case '!has': {
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
      const inner = exprToXgis(v[1], warnings)
      if (inner === null) return null
      return `get(${inner}) == null`
    }
    case 'coalesce': {
      // Mapbox spec: at least one argument required.
      if (v.length < 2) {
        warnings.push(`Malformed ["coalesce"] expression: expected at least 1 argument, got 0.`)
        return null
      }
      const args = v.slice(1).map(a => exprToXgis(a, warnings))
      const valid = args.filter((a): a is string => a !== null)
      // Surface partial-drop when SOME but not all args converted —
      // pre-fix the invalid arms vanished silently so a coalesce
      // expression that authored a fallback chain
      // `["coalesce", ["image", "icon"], ["literal", "#abc"]]` could
      // drop the unsupported `image` head and the runtime would always
      // hit the colour fallback even when the icon was meant to
      // resolve. Total-failure (length === 0) keeps the existing
      // bail-to-null so callers know nothing converted.
      if (valid.length === 0) return null
      if (valid.length < args.length) {
        warnings.push(`["coalesce"] dropped ${args.length - valid.length} of ${args.length} args that failed to convert; resulting fallback chain may differ from the authored intent.`)
      }
      // Parenthesize ternary arms so the `??` fallback can't migrate
      // into a non-final arm's else-branch (parser puts `?:` above `??`).
      return valid.map(parenthesizeTernary).join(' ?? ')
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
      // Fall back to `null` (not `0`) when the default arm fails to
      // convert. Pre-fix the numeric '0' fallback type-mismatched
      // colour cases — the runtime received '0' where a hex was
      // expected and the layer rendered transparent. `null` reads
      // as the Identifier(null), which the evaluator coerces by
      // context (colour → no fill default; number → 0; bool → false).
      let result = def ?? 'null'
      let droppedArms = 0
      for (let i = args.length - 3; i >= 0; i -= 2) {
        const cond = exprToXgis(args[i], warnings)
        const val = exprToXgis(args[i + 1], warnings)
        if (cond === null || val === null) { droppedArms++; continue }
        result = `${cond} ? ${val} : ${result}`
      }
      // Surface partial-drop: a case arm whose cond OR val failed to
      // convert was previously silently skipped — the resulting
      // ternary chain fell through to the default for that condition
      // with NO diagnostic. Real styles with one experimental arm
      // (e.g. `["image", …]` head, currently unsupported) would lose
      // the entire conditional path silently.
      if (droppedArms > 0) {
        warnings.push(`["case"] dropped ${droppedArms} arm(s) whose cond or value failed to convert; remaining chain may collapse to default for the affected conditions.`)
      }
      return result
    }
    case 'match': {
      return convertMatch(v, warnings, exprToXgis)
    }
    case 'all': {
      const rawCount = v.length - 1
      const parts = v.slice(1).map(a => filterToXgis(a, warnings)).filter((s): s is string => !!s)
      // Surface partial-drop — pre-fix a sub-filter that couldn't
      // convert (e.g. `["image", …]` head) silently disappeared
      // from the AND chain, so `["all", real-filter, unsupported]`
      // collapsed to just `real-filter` and the layer's authored
      // AND constraint was lost.
      if (parts.length < rawCount && rawCount > 0) {
        warnings.push(`["all"] dropped ${rawCount - parts.length} of ${rawCount} sub-filter(s) that failed to convert; remaining AND chain is more permissive than the authored intent.`)
      }
      if (parts.length === 0) return 'true'
      return parts.map(parenthesize).join(' && ')
    }
    case 'any': {
      const rawCount = v.length - 1
      const parts = v.slice(1).map(a => filterToXgis(a, warnings)).filter((s): s is string => !!s)
      // Same partial-drop pattern as ["all"]. OR-chains hurt
      // DIFFERENTLY — dropping an arm narrows the accepted set, so
      // the layer becomes MORE restrictive than the author intended.
      if (parts.length < rawCount && rawCount > 0) {
        warnings.push(`["any"] dropped ${rawCount - parts.length} of ${rawCount} sub-filter(s) that failed to convert; remaining OR chain accepts fewer features than the authored intent.`)
      }
      if (parts.length === 0) return 'false'
      return parts.map(parenthesize).join(' || ')
    }
    case '!': {
      if (v.length < 2) {
        warnings.push(`Malformed ["!"] expression: missing inner filter argument.`)
        return null
      }
      const inner = filterToXgis(v[1], warnings)
      return inner ? `!(${inner})` : null
    }
    // Comparison operators. Mapbox spec allows a trailing
    // `["collator", {…}]` arg that controls case-sensitivity /
    // locale-aware ordering of string compares (`["==", a, b,
    // ["collator", { "case-sensitive": false }]]`). X-GIS string
    // comparison is byte-exact — we drop the collator with a warning
    // and proceed with the bare a/b. Without this branch the 4-arg
    // form fell to the length-check below and returned null, hiding
    // the entire predicate.
    case '==': case '!=': case '<': case '<=': case '>': case '>=': {
      if (v.length === 4) {
        const collator = v[3]
        if (Array.isArray(collator) && collator[0] === 'collator') {
          warnings.push(`["${op}"] trailing ["collator", …] dropped — X-GIS string compare is byte-exact (no case-insensitive / locale-aware ordering).`)
          const a = exprToXgis(v[1], warnings)
          const b = exprToXgis(v[2], warnings)
          if (a === null || b === null) return null
          return `${a} ${op} ${b}`
        }
      }
      if (v.length !== 3) return null
      const a = exprToXgis(v[1], warnings)
      const b = exprToXgis(v[2], warnings)
      if (a === null || b === null) return null
      return `${a} ${op} ${b}`
    }
    // Arithmetic operators. Mapbox spec: `+`/`*` variadic (≥ 2 args);
    // `-` unary (negation) OR binary; `/`/`%` strictly binary. Pre-fix
    // the shared comparison branch required EXACTLY 2 operands, so the
    // variadic/unary forms returned null and silently collapsed the
    // whole containing case/interpolate/paint value. Evaluator supports
    // binary +,-,*,/,% and unary -; `(a + b + c)` parses left-assoc.
    case '+': case '*': {
      if (v.length < 3) {
        warnings.push(`["${op}"] expects at least 2 arguments, got ${v.length - 1}.`)
        return null
      }
      const parts = v.slice(1).map(a => exprToXgis(a, warnings))
      if (parts.some(p => p === null)) return null
      return `(${parts.join(` ${op} `)})`
    }
    case '-': {
      if (v.length === 2) {
        const a = exprToXgis(v[1], warnings)
        return a === null ? null : `(-(${a}))`
      }
      if (v.length === 3) {
        const a = exprToXgis(v[1], warnings)
        const b = exprToXgis(v[2], warnings)
        if (a === null || b === null) return null
        return `${a} - ${b}`
      }
      warnings.push(`["-"] expects 1 or 2 arguments, got ${v.length - 1}.`)
      return null
    }
    case '/': case '%': {
      if (v.length !== 3) {
        warnings.push(`["${op}"] expects exactly 2 arguments, got ${v.length - 1}.`)
        return null
      }
      const a = exprToXgis(v[1], warnings)
      const b = exprToXgis(v[2], warnings)
      if (a === null || b === null) return null
      return `${a} ${op} ${b}`
    }
    case 'array': {
      // Mapbox `["array", value]` / `["array", "type", value]` /
      // `["array", "type", N, value]` — type assertion that returns
      // the value if it's an array (with optional element-type / length
      // checks). X-GIS arrays carry no per-element type tag so we
      // just pass the underlying value through; the spec's "abort if
      // not array" semantic is lost but for paint/filter use that's
      // already implicit (an interpolate over a missing array would
      // null-cascade anyway).
      // Last arg is always the value; preceding args are type/length
      // metadata we ignore.
      // Pre-fix a bare `["array"]` (no value) picked v[0] = "array"
      // itself and emitted the literal string `"array"` as a quoted
      // identifier. Require at least one arg beyond the op.
      if (v.length < 2) {
        warnings.push(`Malformed ["array"] expression: missing inner value.`)
        return null
      }
      const value = v[v.length - 1]
      return exprToXgis(value, warnings)
    }
    case 'min': case 'max': {
      // Mapbox spec: ≥ 1 argument required. Pre-fix `["min"]` /
      // `["max"]` (zero args) returned null silently with no
      // diagnostic; same for partial-drop when some args failed
      // to convert (the result misleadingly succeeded with fewer
      // operands than authored).
      if (v.length < 2) {
        warnings.push(`Malformed ["${op}"] expression: expected at least 1 argument, got 0.`)
        return null
      }
      const rawCount = v.length - 1
      const args = v.slice(1).map(x => exprToXgis(x, warnings)).filter((s): s is string => s !== null)
      if (args.length < rawCount) {
        warnings.push(`["${op}"] dropped ${rawCount - args.length} of ${rawCount} arg(s) that failed to convert; result may differ from authored intent.`)
      }
      return args.length > 0 ? `${op}(${args.join(', ')})` : null
    }
    case 'to-number': case 'number':
    case 'to-string': case 'string':
    case 'to-boolean': case 'boolean':
    case 'to-color': {
      // Mapbox spec: `["number", value, fallback1, fallback2, …]`
      // (and the `to-number` / `string` / `boolean` / `to-color`
      // variants) returns the FIRST arg of the right type, else the
      // next fallback. X-GIS evaluator coerces by context — there's
      // no per-type "is the right type" check — so we use coalesce()
      // as a best-effort fallback chain.
      //
      // Pre-fix the multi-arg fallback was dropped (only the first
      // value passed through). That hurt styles that author
      // `["number", ["get", "height"], 0]` to default missing fields
      // to 0 — when the property was missing, the inner returned
      // null and the layer's height collapsed to whatever the
      // evaluator's null-arithmetic default was (typically 0, but
      // for layouts like `interpolate(zoom, … null …)` could break).
      const args = v.slice(1).map(a => exprToXgis(a, warnings))
      const valid = args.filter((a): a is string => a !== null)
      if (valid.length === 0) return null
      // Surface partial-drop — mirror of coalesce/case/match partial-
      // drop warnings. A fallback chain with one unsupported head
      // (`["to-number", ["image", "x"], 0]`) would silently lose the
      // image-resolution attempt and always hit the `0` default. The
      // visible-vs-authored mismatch was unfindable without this
      // diagnostic.
      if (valid.length < args.length) {
        warnings.push(`["${op}"] dropped ${args.length - valid.length} of ${args.length} arg(s) that failed to convert; resulting fallback chain may differ from the authored intent.`)
      }
      if (valid.length === 1) return valid[0]!
      // Parenthesize ternary arms — see coalesce note: an unwrapped
      // ternary arm would swallow the `??` fallback into its else.
      return valid.map(parenthesizeTernary).join(' ?? ')
    }
    case 'interpolate':
    case 'interpolate-lab':
    case 'interpolate-hcl': {
      return convertInterpolate(v, warnings, exprToXgis)
    }
    // ─── Batch 6: math + trig + log builtins ───
    // All of these have a 1:1 evaluator builtin (callBuiltin in
    // compiler/src/eval/evaluator.ts). The converter just wraps the
    // operands in a function-call shape the parser turns back into a
    // FnCall expression.
    case '^': {
      // Mapbox `["^", a, b]` → xgis `pow(a, b)`. Two args required.
      if (v.length !== 3) {
        warnings.push(`Malformed ["^"] expression: expected 2 arguments, got ${v.length - 1}.`)
        return null
      }
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
      // Mapbox spec: all of these take exactly one argument.
      // A bare `["abs"]` (no operand) used to silently drop because
      // exprToXgis(undefined) returns null; the user got no
      // diagnostic and wondered why the abs() didn't convert.
      if (v.length !== 2) {
        warnings.push(`Malformed ["${op}"] expression: expected 1 argument, got ${v.length - 1}.`)
        return null
      }
      const inner = exprToXgis(v[1], warnings)
      return inner !== null ? `${op}(${inner})` : null
    }
    case 'pi': case 'e': case 'ln2': {
      // Zero-arg constants — Mapbox emits `["pi"]`. The evaluator
      // resolves these as builtin calls with empty arg lists.
      // Extra args would be silently dropped — warn so the author
      // doesn't accidentally pass operands to a no-arg constant.
      if (v.length !== 1) {
        warnings.push(`Malformed ["${op}"] expression: zero-arg constant takes no arguments, got ${v.length - 1}.`)
      }
      return `${op}()`
    }
    case 'concat': {
      // Mapbox `["concat", a, b, …]` → xgis `concat(a, b, …)`. The
      // evaluator coerces each arg to string with null-skipping
      // semantics that match the Mapbox spec.
      // Zero-arg `["concat"]` and all-null `["concat", null, null]`
      // both return empty string per Mapbox spec. Pre-fix the empty
      // case returned null which silently dropped the property
      // (e.g. text-field collapsed to no label).
      const rawArgs = v.slice(1)
      const rawNonNullCount = rawArgs.filter(a => a !== null && a !== undefined).length
      const parts = rawArgs.map(a => exprToXgis(a, warnings)).filter((s): s is string => s !== null)
      // Surface partial-drop — an `["image", …]` head in a concat
      // chain (e.g. `["concat", ["image", "icon"], " ", ["get",
      // "name"]]`) would silently lose the icon and emit
      // `concat(" ", get("name"))`, missing the authored prefix.
      // null/undefined ARGS are explicitly permitted by Mapbox spec
      // (skip-null semantic) so we only count non-null inputs that
      // failed to convert.
      if (parts.length < rawNonNullCount) {
        warnings.push(`["concat"] dropped ${rawNonNullCount - parts.length} of ${rawNonNullCount} non-null arg(s) that failed to convert; concatenation may be missing the authored content.`)
      }
      return parts.length > 0 ? `concat(${parts.join(', ')})` : '""'
    }
    case 'format': {
      // Mapbox `["format", text1, opts1, text2, opts2, …]`. Each
      // (text, opts) pair is a span — `text` is the value to render,
      // `opts` is `{}` for plain spans or an object with span-level
      // overrides (font-scale, text-color, text-font, vertical-align)
      // for rich-text labels. X-GIS labels currently render with one
      // font/colour per layer, so we DROP the opts and concatenate
      // the texts — preserving the displayed text content without
      // the typography. Pre-fix the whole text-field collapsed to
      // null and the layer dropped silently. Real-world hit: OFM
      // Bright's road-shield + place-name layers use ["format", …]
      // for primary-name + secondary-locale fallback.
      const args = v.slice(1)
      if (args.length === 0) return null
      if (args.length % 2 !== 0) {
        warnings.push(`Malformed ["format"] — text+opts pairs required: ${JSON.stringify(v).slice(0, 120)}`)
        return null
      }
      let hasRichOpts = false
      const texts: string[] = []
      let droppedSections = 0
      for (let i = 0; i < args.length; i += 2) {
        const text = args[i]
        const opts = args[i + 1]
        // Empty opts `{}` is the bare-text case — no warning needed.
        // Anything non-empty means the user requested styling we can't
        // express; flag once per format call so the conversion notes
        // surface the gap without N copies.
        if (opts && typeof opts === 'object' && !Array.isArray(opts)
            && Object.keys(opts as Record<string, unknown>).length > 0) {
          hasRichOpts = true
        }
        const t = exprToXgis(text, warnings)
        if (t === null) {
          // Partial-drop: skip the failed section but keep the rest
          // (Plan §1 §1 finishing — pre-fix the whole format bailed
          // entirely when any one section failed, dropping the
          // label visibly). Surface WHICH section failed so the user
          // can locate it without bisecting the format chain.
          warnings.push(`["format"] section ${i / 2 + 1} (${JSON.stringify(text).slice(0, 60)}) failed to convert — dropped from concat; remaining sections still emit.`)
          droppedSections++
          continue
        }
        texts.push(t)
      }
      // Only bail if EVERY section failed; otherwise emit whatever
      // sections survived. Mirrors the partial-drop semantics for
      // coalesce / case / match / concat — never silently empty
      // unless there's truly nothing to emit.
      if (texts.length === 0) {
        warnings.push(`["format"] all ${droppedSections} sections failed to convert — format expression returns null.`)
        return null
      }
      if (hasRichOpts) {
        warnings.push(`["format"] span-level options (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer.`)
      }
      if (texts.length === 1) return texts[0]!
      return `concat(${texts.join(', ')})`
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
      // Mapbox spec strict: stop x-values (positions 3, 5, 7, …)
      // MUST be literal finite numbers — same constraint as
      // interpolate. Pre-fix step accepted any expression at stop
      // positions, breaking the spec's "step input → bucketed
      // output" semantic (the stops must form a monotonic axis).
      // Unwrap ["literal", N] wraps because v8 strict tooling emits
      // those for explicit numeric literals.
      const stopXs: number[] = []
      for (let i = 3; i < v.length; i += 2) {
        let stopX: unknown = v[i]
        while (Array.isArray(stopX) && stopX.length === 2 && stopX[0] === 'literal') stopX = stopX[1]
        if (typeof stopX !== 'number' || !Number.isFinite(stopX)) {
          const stopIdx = ((i - 3) / 2) | 0
          warnings.push(`["step"] stop ${stopIdx + 1} x-value must be a literal finite number per Mapbox spec; got ${JSON.stringify(v[i]).slice(0, 80)}. Whole step bails.`)
          return null
        }
        stopXs.push(stopX)
      }
      // Mapbox spec: step stops must be strictly ascending — same
      // requirement as interpolate (iter 74 gate). Non-monotonic
      // step stops produce undefined evaluator output (the runtime
      // bucket scan picks the first range matching the input).
      for (let i = 1; i < stopXs.length; i++) {
        if (stopXs[i]! <= stopXs[i - 1]!) {
          warnings.push(`["step"] stops not strictly ascending: stop ${i + 1} input=${stopXs[i]} <= stop ${i} input=${stopXs[i - 1]}. Mapbox spec requires monotonically increasing input values — evaluator output is undefined for the violating range.`)
          break // one warning per step, not per pair
        }
      }
      const args = v.slice(1).map((a, idx) => {
        // Stop x-values (positions 3, 5, 7, … in v → idx 2, 4, 6,
        // … in args) are validated literal numbers — bypass
        // exprToXgis and stringify the literal directly. Values
        // (idx 3, 5, 7, …) and input (0) + default (1) go through
        // exprToXgis as normal.
        if (idx >= 2 && idx % 2 === 0) {
          let v2: unknown = a
          while (Array.isArray(v2) && v2.length === 2 && v2[0] === 'literal') v2 = v2[1]
          return String(v2)
        }
        return exprToXgis(a, warnings)
      })
      // Surface which positional arg failed so the user can locate
      // it without bisecting. Total-bail kept (step semantics require
      // every slot to convert) — this is precision over the silent
      // null return.
      const failedIdx = args.findIndex(a => a === null)
      if (failedIdx !== -1) {
        const slotName = failedIdx === 0 ? 'input'
          : failedIdx === 1 ? 'default'
          : failedIdx % 2 === 0 ? `stop ${(failedIdx / 2) | 0}`
          : `value ${((failedIdx - 1) / 2) | 0}`
        warnings.push(`["step"] arg ${failedIdx + 1} (${slotName}) failed to convert; whole step bails.`)
        return null
      }
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
      const seenNames = new Set<string>()
      const duplicateNames: string[] = []
      for (let i = 0; i < args.length - 1; i += 2) {
        const name = args[i]
        if (typeof name !== 'string') {
          warnings.push(`Malformed ["let"] expression: binding name at slot ${i} is ${typeof name}, expected string.`)
          return null
        }
        if (seenNames.has(name)) {
          duplicateNames.push(name)
        } else {
          seenNames.add(name)
        }
        // Mapbox spec doesn't formally forbid duplicate let names but
        // the evaluator semantic is undefined when a name is bound
        // twice (our substitution uses Map.set, so LAST write wins —
        // earlier bindings become silent dead code).
        bindings.set(name, args[i + 1])
      }
      if (duplicateNames.length > 0) {
        warnings.push(`["let"] duplicate binding name(s) ${duplicateNames.slice(0, 4).map(d => `"${d}"`).join(', ')}${duplicateNames.length > 4 ? ` + ${duplicateNames.length - 4} more` : ''}. The LAST binding wins; earlier ones are silent dead code.`)
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
      if (v.length !== 3) {
        warnings.push(`Malformed ["at"] expression: expected 2 arguments (index, array), got ${v.length - 1}.`)
        return null
      }
      const idx = exprToXgis(v[1], warnings)
      const arr = exprToXgis(v[2], warnings)
      if (idx === null || arr === null) return null
      return `${arr}[${idx}]`
    }
    case 'typeof': {
      // Mapbox `["typeof", value]` → xgis `typeof(value)`. The
      // evaluator returns "string" / "number" / "boolean" / "object" /
      // "null" matching the Mapbox spec.
      if (v.length !== 2) {
        warnings.push(`Malformed ["typeof"] expression: expected 1 argument, got ${v.length - 1}.`)
        return null
      }
      const inner = exprToXgis(v[1], warnings)
      return inner !== null ? `typeof(${inner})` : null
    }
    case 'slice': {
      // Mapbox `["slice", input, start]` or `["slice", input, start, end]`.
      // Routes through xgis `slice(input, start[, end])` builtin.
      if (v.length < 3 || v.length > 4) {
        warnings.push(`Malformed ["slice"] expression: expected 2-3 arguments (input, start[, end]), got ${v.length - 1}.`)
        return null
      }
      const parts = v.slice(1).map(a => exprToXgis(a, warnings))
      if (parts.some(p => p === null)) return null
      return `slice(${parts.join(', ')})`
    }
    case 'index-of': {
      // Mapbox `["index-of", needle, haystack]` or
      // `["index-of", needle, haystack, from_index]`.
      if (v.length < 3 || v.length > 4) {
        warnings.push(`Malformed ["index-of"] expression: expected 2-3 arguments (needle, haystack[, from_index]), got ${v.length - 1}.`)
        return null
      }
      const parts = v.slice(1).map(a => exprToXgis(a, warnings))
      if (parts.some(p => p === null)) return null
      // xgis identifier names can't contain hyphens; route to the
      // underscore-bridged builtin which the evaluator binds.
      return `index_of(${parts.join(', ')})`
    }
    case 'number-format': {
      // Mapbox `["number-format", input, { locale?, currency?,
      // "min-fraction-digits"?, "max-fraction-digits"? }]`. xgis has
      // no object literal in source syntax, so flatten to a positional
      // call:  number_format(input, minFrac, maxFrac, locale, currency).
      // Absent fields lower to `null` literals — the evaluator treats
      // null as "use spec default" for each slot.
      if (v.length !== 3) {
        warnings.push(`Malformed ["number-format"] expression: expected 2 arguments (input, options), got ${v.length - 1}.`)
        return null
      }
      const input = exprToXgis(v[1], warnings)
      if (input === null) return null
      const opts = v[2]
      if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
        warnings.push(`["number-format"] options arg must be a literal object: ${JSON.stringify(opts).slice(0, 80)}`)
        return null
      }
      const o = opts as Record<string, unknown>
      const fmtVal = (val: unknown): string => {
        if (val === undefined || val === null) return 'null'
        if (typeof val === 'string') return JSON.stringify(val)
        // Reject NaN/Infinity — String(NaN) = "NaN" would land in
        // the emitted number_format call as a bare identifier, the
        // parser would resolve it to props['NaN'] (typically
        // undefined), and number-format silently fell to spec
        // default with no diagnostic.
        if (typeof val === 'number' && !Number.isFinite(val)) return 'null'
        return String(val)
      }
      const minFrac = fmtVal(o['min-fraction-digits'])
      const maxFrac = fmtVal(o['max-fraction-digits'])
      const locale = fmtVal(o.locale)
      const currency = fmtVal(o.currency)
      return `number_format(${input}, ${minFrac}, ${maxFrac}, ${locale}, ${currency})`
    }
    case 'rgb': case 'rgba': {
      // Mapbox `["rgb", r, g, b]` / `["rgba", r, g, b, a]` — channel
      // expressions. When all channels are constant numbers we can
      // hex-encode at convert time; otherwise leave as a function
      // call for the evaluator to handle (which it doesn't currently;
      // surfaces as a warning so callers know).
      // Per-channel literal-wrap unwrap so v8 strict tooling's
      // `["rgb", ["literal", 255], ["literal", 0], ["literal", 0]]`
      // still hex-encodes at convert time. Mirror of the same
      // unwrap inside colorToXgis (commit 1927580).
      const ch = v.slice(1).map((c) => {
        while (Array.isArray(c) && c.length === 2 && c[0] === 'literal') c = c[1]
        return c
      })
      // Arity check: rgb needs 3 channels, rgba needs 4. Pre-fix a
      // malformed `["rgba", r, g, b]` (missing alpha) left `a` as
      // undefined; Math.round(undefined * 255) gave NaN and the
      // emitted hex carried the literal string 'NaN' (e.g. #ff0000NaN)
      // which the runtime hex parser then failed silently on.
      const requiredCh = op === 'rgb' ? 3 : 4
      if (ch.length !== requiredCh) {
        warnings.push(`["${op}"] expected ${requiredCh} channels, got ${ch.length}: ${JSON.stringify(v).slice(0, 80)}`)
        return null
      }
      // Number.isFinite gate — NaN passes typeof; Math.round(NaN) is
      // NaN; `(NaN).toString(16)` is "NaN" → emitted hex literal
      // would be `#NaNNaNNaN` which the runtime parseHexColor regex
      // rejects, silently collapsing the colour to opaque black.
      const allNumeric = ch.every(c => typeof c === 'number' && Number.isFinite(c))
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
    case 'zoom': {
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
    case 'geometry-type': {
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
    case 'id': {
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
    case 'in': {
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
          : exprToXgis(field, warnings)
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
  }
  // Mapbox-specific accessors with dedicated runtime support pending:
  // surface a precise message instead of the generic "Expression not
  // converted" catch-all so the user sees the gap is feature-specific
  // (heatmap pipeline, line-gradient, feature-state, etc.) not a
  // generic shape problem.
  const unsupportedOp = (v as unknown[])[0]
  if (typeof unsupportedOp === 'string') {
    const KNOWN_UNSUPPORTED: Record<string, string> = {
      'heatmap-density': 'Heatmap density accessor — heatmap layer rendering is Batch 3 (accumulation MRT + Gaussian blur); no runtime support today.',
      'line-progress': 'Line-progress accessor — line-gradient requires source.lineMetrics + a per-fragment progress varying; not yet implemented.',
      'sky-radial-progress': 'Sky-radial-progress accessor — sky layer rendering not implemented.',
      'accumulated': 'Accumulated accessor — clusterProperties pipeline not implemented (clustering is host-side today).',
      'distance-from-center': 'Distance-from-center accessor — globe-mode runtime queries not wired through to filter eval yet.',
      'pitch': 'Camera pitch accessor — runtime pitch is not exposed as a filter/paint input today.',
      'feature-state': 'Feature-state accessor — map.setFeatureState() / hover-state is not yet implemented; values resolve to null.',
      'image': 'Image accessor — sprite atlas (Batch 2) not yet implemented; the layer falls through to its colour-only fallback.',
      'within': 'Within accessor — polygon-containment filter not yet implemented; predicate evaluates to false.',
      'is-supported-script': 'is-supported-script accessor — Unicode script-coverage check not implemented; predicate evaluates to false.',
      'resolved-locale': 'resolved-locale accessor — collator-resolved BCP-47 locale tag not implemented; returns null.',
      'collator': 'collator object — locale-aware string ordering not implemented; comparison operators fall back to byte-exact compare.',
      // Iter 544 additions — Mapbox spec ops the converter dropped to
      // the generic "Expression not converted" catch-all. Specific
      // messages so the lossy report surfaces the actual feature gap.
      'properties': 'Feature properties bag accessor — Mapbox `["properties"]` returns the entire feature.properties object; xgis evaluates property access lazily via `.field` / `get("field")` so the bulk-bag form is moot for paint/filter usage. Returns null if reached.',
      'distance': 'Geometry distance accessor — Mapbox `["distance", geometry]` returns metric distance from the feature to a target GeoJSON shape; requires a geometric-distance pipeline not yet wired (would need turf-style polygon-to-line nearest-neighbour at filter eval time).',
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
  while (Array.isArray(peeledPseudoField) && peeledPseudoField.length === 2
      && peeledPseudoField[0] === 'literal') {
    peeledPseudoField = peeledPseudoField[1]
  }
  if ((op === '==' || op === '!=' || op === 'in' || op === '!in') &&
      (peeledPseudoField === '$type' || peeledPseudoField === '$id')) {
    const accessorExpr = peeledPseudoField === '$type'
      ? ['geometry-type']
      : ['id']
    const accessorStr = peeledPseudoField === '$type'
      ? 'get("$geometryType")'
      : 'get("$featureId")'
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
      const kStr = typeof k === 'string' ? JSON.stringify(k)
        : typeof k === 'number' || typeof k === 'boolean' ? String(k) : null
      if (kStr === null) {
        warnings.push(`["${op}"] with "${ peeledPseudoField }" dropped a key that is not a literal string/number/boolean: ${JSON.stringify(k).slice(0, 60)}`)
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
      const eqs = v.slice(2).map(k => {
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
