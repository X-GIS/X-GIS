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
      const inner = v[1]
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
      if (Array.isArray(f) && f.length === 2 && f[0] === 'literal' && typeof f[1] === 'string') {
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
        const escaped = f.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        return `get("${escaped}")`
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
      let field: unknown = v[1]
      if (Array.isArray(field) && field.length === 2 && field[0] === 'literal'
          && typeof field[1] === 'string') {
        field = field[1]
      }
      if (typeof field === 'string') {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return `.${field} != null`
        // Colon-bearing locale keys round-trip through get("…") which
        // already returns null on miss (matching Mapbox's "has" sense).
        const escaped = field.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        return `get("${escaped}") != null`
      }
      const inner = exprToXgis(v[1], warnings)
      if (inner === null) return null
      return `get(${inner}) != null`
    }
    case '!has': {
      // Mirror of the `has` dynamic-key fix.
      let field: unknown = v[1]
      if (Array.isArray(field) && field.length === 2 && field[0] === 'literal'
          && typeof field[1] === 'string') {
        field = field[1]
      }
      if (typeof field === 'string') {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return `.${field} == null`
        const escaped = field.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        return `get("${escaped}") == null`
      }
      const inner = exprToXgis(v[1], warnings)
      if (inner === null) return null
      return `get(${inner}) == null`
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
        // Mapbox v8 strict tooling can emit `["literal", [k1, k2]]`
        // for the keys-array form. Without unwrap, the outer
        // Array.isArray check passed and the iteration produced
        // arms `"literal" -> val`, `[k1, k2] -> val` — both wrong.
        // The bare-array shape `[k1, k2]` is still accepted.
        let key = args[i]
        if (Array.isArray(key) && key.length === 2 && key[0] === 'literal') {
          key = key[1]
        }
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
      // Mapbox spec allows comparison ops to accept a trailing
      // `["collator", {…}]` arg that controls case-sensitivity /
      // locale-aware ordering of string compares (`["==", a, b,
      // ["collator", { "case-sensitive": false }]]`). X-GIS string
      // comparison is byte-exact — we drop the collator with a warning
      // and proceed with the bare a/b. Without this branch the 4-arg
      // form fell to the length-check below and returned null, hiding
      // the entire predicate.
      if (v.length === 4
          && (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=')) {
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
      const value = v[v.length - 1]
      return exprToXgis(value, warnings)
    }
    case 'min': case 'max': {
      const args = v.slice(1).map(x => exprToXgis(x, warnings)).filter((s): s is string => s !== null)
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
      if (valid.length === 1) return valid[0]!
      return valid.join(' ?? ')
    }
    case 'interpolate':
    case 'interpolate-lab':
    case 'interpolate-hcl': {
      // Mapbox `["interpolate", curve, input, x1, y1, x2, y2, …]`. The
      // converter has a dedicated zoom-stops path (paint.ts /
      // interpolateZoomCall) that wraps everything in
      // `interpolate(zoom, …)` and `interpolate_exp(zoom, base, …)`
      // when the input IS `["zoom"]`. NON-zoom inputs — `["get",
      // "magnitude"]`, `["heatmap-density"]`, `["feature-state",
      // "hover"]`, etc. — fall through here so per-feature
      // interpolations don't drop. Common pattern: `circle-radius:
      // interpolate(linear, get("mag"), 0, 1, 10, 20)` for earthquake
      // magnitude scaling, similar for per-feature line-width / opacity.
      // LAB/HCL colour-space interpolation is approximated as
      // linear-RGB — the evaluator has no per-stop colour-space
      // walker yet (same trade-off paint.ts uses for the zoom path).
      if (v.length < 5) return null
      const curveSpec = v[1]
      const input = exprToXgis(v[2], warnings)
      if (input === null) return null
      let isExp = false
      let base = 1
      if (Array.isArray(curveSpec)) {
        if (curveSpec[0] === 'exponential' && typeof curveSpec[1] === 'number') {
          if (curveSpec[1] !== 1) { isExp = true; base = curveSpec[1] }
        } else if (curveSpec[0] === 'cubic-bezier') {
          warnings.push(`["interpolate", ["cubic-bezier", …], …] folded to linear — xgis has no per-stop bezier interpolator.`)
        }
      }
      if (op === 'interpolate-lab' || op === 'interpolate-hcl') {
        warnings.push(`${op}(…) approximated as linear-RGB — xgis has no LAB/HCL per-stop evaluator yet.`)
      }
      const stopArgs: string[] = []
      for (let i = 3; i + 1 < v.length; i += 2) {
        const z = exprToXgis(v[i], warnings)
        const y = exprToXgis(v[i + 1], warnings)
        if (z === null || y === null) return null
        stopArgs.push(z, y)
      }
      if (stopArgs.length < 4) return null
      if (isExp) return `interpolate_exp(${input}, ${base}, ${stopArgs.join(', ')})`
      return `interpolate(${input}, ${stopArgs.join(', ')})`
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
        if (t === null) return null
        texts.push(t)
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
      // Mapbox `["typeof", value]` → xgis `typeof(value)`. The
      // evaluator returns "string" / "number" / "boolean" / "object" /
      // "null" matching the Mapbox spec.
      if (v.length !== 2) return null
      const inner = exprToXgis(v[1], warnings)
      return inner !== null ? `typeof(${inner})` : null
    }
    case 'slice': {
      // Mapbox `["slice", input, start]` or `["slice", input, start, end]`.
      // Routes through xgis `slice(input, start[, end])` builtin.
      if (v.length < 3 || v.length > 4) return null
      const parts = v.slice(1).map(a => exprToXgis(a, warnings))
      if (parts.some(p => p === null)) return null
      return `slice(${parts.join(', ')})`
    }
    case 'index-of': {
      // Mapbox `["index-of", needle, haystack]` or
      // `["index-of", needle, haystack, from_index]`.
      if (v.length < 3 || v.length > 4) return null
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
      if (v.length !== 3) return null
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
    case 'zoom': {
      // Mapbox `["zoom"]` accessor → xgis bare `zoom` identifier.
      // The evaluator special-cases the name (eval/evaluator.ts:40)
      // to read `props[CAMERA_ZOOM_KEY]`, so the dedicated zoom-stops
      // path in paint.ts AND this generic exprToXgis route both
      // resolve to the same live camera zoom at evaluation time.
      // Pre-fix `["zoom"]` outside the dedicated path (e.g. nested
      // inside a `case` / `match` arm) fell to "Expression not
      // converted" and the containing expression dropped silently.
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
      return 'get("$geometryType")'
    }
    case 'id': {
      // Mapbox ["id"] resolves to feature.id (GeoJSON RFC 7946 §3.2;
      // MVT feature.id from the protobuf). Same routing pattern as
      // ["geometry-type"] — the runtime filter-eval sites inject
      // `$featureId` into the props bag at evaluation time so the
      // ["==", ["id"], 42] / ["match", ["id"], …] filters work.
      return 'get("$featureId")'
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
        // Each key in the values list can itself be v8-literal-wrapped
        // (Mapbox strict tooling: `["literal", [["literal", "a"], "b"]]`).
        // Unwrap eagerly so the equality emit sees the bare value.
        const eqs = list[1].map((k: unknown) => {
          if (Array.isArray(k) && k.length === 2 && k[0] === 'literal') k = k[1]
          return `${fxg} == ${typeof k === 'string' ? JSON.stringify(k) : k}`
        })
        return eqs.join(' || ')
      }
      if (typeof field === 'string') {
        const eqs = v.slice(2).map(k => {
          if (Array.isArray(k) && k.length === 2 && k[0] === 'literal') k = k[1]
          return `.${field} == ${typeof k === 'string' ? JSON.stringify(k) : k}`
        })
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

  // Unwrap v8 literal-wraps on the boolean values + default. A
  // strict-tooling-emitted form like
  // `["match", input, k, ["literal", true], ["literal", false]]`
  // would pre-fix fail the `typeof ... === 'boolean'` gate and
  // matchToBooleanFilter returned null — the filter fell to the
  // generic match() path and the merge / dispatch lost its
  // boolean-fast-path opportunity.
  const unwrapBool = (x: unknown): unknown =>
    Array.isArray(x) && x.length === 2 && x[0] === 'literal' ? x[1] : x
  const defUnwrapped = unwrapBool(def)
  // All values + default must be boolean literals.
  const allBool = (() => {
    if (typeof defUnwrapped !== 'boolean') return false
    for (let i = 1; i < args.length - 1; i += 2) {
      if (typeof unwrapBool(args[i]) !== 'boolean') return false
    }
    return true
  })()
  if (!allBool) return null

  const inputXgis = exprToXgis(input, warnings)
  if (inputXgis === null) return null

  // Polarity: default `false` → OR of equality for true-arms.
  // Default `true` → AND of inequality for false-arms (the "not in
  // <keys>" form).
  const polarity = defUnwrapped === false
  const eqOp = polarity ? '==' : '!='
  const join = polarity ? ' || ' : ' && '
  const targetVal = polarity

  const parts: string[] = []
  for (let i = 0; i < args.length - 1; i += 2) {
    // Unwrap Mapbox v8 `["literal", [k1, k2]]` keys-array wrapper —
    // mirror of the main match handler. Pre-fix the wrapped form
    // iterated "literal" + the actual key list as separate arms.
    let key = args[i]
    if (Array.isArray(key) && key.length === 2 && key[0] === 'literal') {
      key = key[1]
    }
    const val = unwrapBool(args[i + 1])
    if (val !== targetVal) continue
    const keys = Array.isArray(key) ? key : [key]
    for (const k of keys) {
      parts.push(`${inputXgis} ${eqOp} ${typeof k === 'string' ? JSON.stringify(k) : k}`)
    }
  }
  if (parts.length === 0) {
    // No matching arms — match collapses to the default literal.
    return String(defUnwrapped)
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
    // Same literal-wrap unwrap pattern as the main match + boolean
    // filter paths — keep the three match handlers in sync.
    let key = args[i]
    if (Array.isArray(key) && key.length === 2 && key[0] === 'literal') {
      key = key[1]
    }
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
  // Unwrap v8 strict `["literal", v]` on the value arg before the
  // is-array gate so the legacy `[\"==\", \"kind\", [\"literal\", \"park\"]]`
  // shape still hits the bare-value fast path. Pre-fix the wrapper
  // pushed the value through to exprToXgis which emitted
  // \`\"kind\" == \"park\"\` (literal-vs-literal), always false.
  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    if (typeof v[1] === 'string') {
      let rawVal = v[2]
      if (Array.isArray(rawVal) && rawVal.length === 2 && rawVal[0] === 'literal') {
        rawVal = rawVal[1]
      }
      if (!Array.isArray(rawVal)) {
        const field = v[1]
        return `.${field} ${op} ${typeof rawVal === 'string' ? JSON.stringify(rawVal) : rawVal}`
      }
    }
  }
  // Legacy `!in` — Mapbox v0/v1 style spec. Per-key unwrap mirrors
  // the `in` op handling — v8 strict tooling can wrap each value
  // (`["literal", "park"]`) and pre-fix the equality emit
  // JSON.stringify'd the wrapper.
  if (op === '!in' && typeof v[1] === 'string') {
    const field = v[1]
    const eqs = v.slice(2).map(k => {
      if (Array.isArray(k) && k.length === 2 && k[0] === 'literal') k = k[1]
      return `.${field} != ${typeof k === 'string' ? JSON.stringify(k) : k}`
    })
    return eqs.join(' && ')
  }
  // Otherwise route through the expression converter — it covers
  // all (non-legacy) forms uniformly.
  return exprToXgis(v, warnings)
}
