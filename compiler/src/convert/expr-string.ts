// String / value-shaping expression cluster → xgis.
//
// Extracted verbatim from expressions.ts's `_exprToXgisImpl` switch:
// literal / array / the type-coercion family (to-number / number / …) /
// concat / format / step / let / var / slice / index-of / number-format /
// rgb / rgba. Each handler is the byte-identical body of its original
// switch arm; recursion is a parameter to avoid importing expressions.ts.

import { parenthesizeTernary } from './utils'
import { substituteVars } from './expressions-helpers'
import type { ExprHandler } from './expr-handler-types'

export const literalHandler: ExprHandler = (v, warnings, recurse) => {
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
      const sub = recurse(el, warnings)
      if (sub === null) return null
      parts.push(sub)
    }
    return `[${parts.join(', ')}]`
  }
  return recurse(inner, warnings)
}

export const arrayHandler: ExprHandler = (v, warnings, recurse) => {
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
  return recurse(value, warnings)
}

export const typeCoercionHandler: ExprHandler = (v, warnings, recurse, _recurseFilter, op) => {
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
  const args = v.slice(1).map((a) => recurse(a, warnings))
  const valid = args.filter((a): a is string => a !== null)
  if (valid.length === 0) return null
  // Surface partial-drop — mirror of coalesce/case/match partial-
  // drop warnings. A fallback chain with one unsupported head
  // (`["to-number", ["image", "x"], 0]`) would silently lose the
  // image-resolution attempt and always hit the `0` default. The
  // visible-vs-authored mismatch was unfindable without this
  // diagnostic.
  if (valid.length < args.length) {
    warnings.push(
      `["${op}"] dropped ${args.length - valid.length} of ${args.length} arg(s) that failed to convert; resulting fallback chain may differ from the authored intent.`,
    )
  }
  if (valid.length === 1) return valid[0]!
  // Parenthesize ternary arms — see coalesce note: an unwrapped
  // ternary arm would swallow the `??` fallback into its else.
  return valid.map(parenthesizeTernary).join(' ?? ')
}

export const concatHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox `["concat", a, b, …]` → xgis `concat(a, b, …)`. The
  // evaluator coerces each arg to string with null-skipping
  // semantics that match the Mapbox spec.
  // Zero-arg `["concat"]` and all-null `["concat", null, null]`
  // both return empty string per Mapbox spec. Pre-fix the empty
  // case returned null which silently dropped the property
  // (e.g. text-field collapsed to no label).
  const rawArgs = v.slice(1)
  const rawNonNullCount = rawArgs.filter((a) => a !== null && a !== undefined).length
  const parts = rawArgs.map((a) => recurse(a, warnings)).filter((s): s is string => s !== null)
  // Surface partial-drop — an `["image", …]` head in a concat
  // chain (e.g. `["concat", ["image", "icon"], " ", ["get",
  // "name"]]`) would silently lose the icon and emit
  // `concat(" ", get("name"))`, missing the authored prefix.
  // null/undefined ARGS are explicitly permitted by Mapbox spec
  // (skip-null semantic) so we only count non-null inputs that
  // failed to convert.
  if (parts.length < rawNonNullCount) {
    warnings.push(
      `["concat"] dropped ${rawNonNullCount - parts.length} of ${rawNonNullCount} non-null arg(s) that failed to convert; concatenation may be missing the authored content.`,
    )
  }
  return parts.length > 0 ? `concat(${parts.join(', ')})` : '""'
}

export const imageHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox `["image", nameExpr]` in a TEXT / format context (#777 I-G) →
  // xgis `image(<nameExpr>)`. The evaluator's `image` builtin wraps the
  // resolved sprite name in the inline-image sentinels so the runtime
  // label shaper can carve it out of the resolved text and render a sprite
  // quad on the baseline. Both the bare `text-field: ["image","pat"]` form
  // and an `["image",…]` section inside `["format",…]` route here (via
  // exprToXgis). The icon-image PROPERTY context is DIFFERENT — it strips
  // the wrapper upstream (unwrapImageExpr) and never reaches this handler.
  if (v.length < 2 || v[1] === undefined) {
    warnings.push(
      `Malformed ["image"] — expected a sprite-name argument: ${JSON.stringify(v).slice(0, 80)}`,
    )
    return null
  }
  const nameExpr = recurse(v[1], warnings)
  if (nameExpr === null) {
    warnings.push(
      `["image"] sprite-name expression could not be converted: ${JSON.stringify(v[1]).slice(0, 80)}`,
    )
    return null
  }
  return `image(${nameExpr})`
}

export const formatHandler: ExprHandler = (v, warnings, recurse) => {
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
    warnings.push(
      `Malformed ["format"] — text+opts pairs required: ${JSON.stringify(v).slice(0, 120)}`,
    )
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
    if (
      opts &&
      typeof opts === 'object' &&
      !Array.isArray(opts) &&
      Object.keys(opts as Record<string, unknown>).length > 0
    ) {
      hasRichOpts = true
    }
    const t = recurse(text, warnings)
    if (t === null) {
      // Partial-drop: skip the failed section but keep the rest
      // (Plan §1 §1 finishing — pre-fix the whole format bailed
      // entirely when any one section failed, dropping the
      // label visibly). Surface WHICH section failed so the user
      // can locate it without bisecting the format chain.
      warnings.push(
        `["format"] section ${i / 2 + 1} (${JSON.stringify(text).slice(0, 60)}) failed to convert — dropped from concat; remaining sections still emit.`,
      )
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
    warnings.push(
      `["format"] all ${droppedSections} sections failed to convert — format expression returns null.`,
    )
    return null
  }
  if (hasRichOpts) {
    warnings.push(
      `["format"] span-level options (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer.`,
    )
  }
  if (texts.length === 1) return texts[0]!
  return `concat(${texts.join(', ')})`
}

export const stepHandler: ExprHandler = (v, warnings, recurse) => {
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
      warnings.push(
        `["step"] stop ${stopIdx + 1} x-value must be a literal finite number per Mapbox spec; got ${JSON.stringify(v[i]).slice(0, 80)}. Whole step bails.`,
      )
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
      warnings.push(
        `["step"] stops not strictly ascending: stop ${i + 1} input=${stopXs[i]} <= stop ${i} input=${stopXs[i - 1]}. Mapbox spec requires monotonically increasing input values — evaluator output is undefined for the violating range.`,
      )
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
    return recurse(a, warnings)
  })
  // Surface which positional arg failed so the user can locate
  // it without bisecting. Total-bail kept (step semantics require
  // every slot to convert) — this is precision over the silent
  // null return.
  const failedIdx = args.findIndex((a) => a === null)
  if (failedIdx !== -1) {
    const slotName =
      failedIdx === 0
        ? 'input'
        : failedIdx === 1
          ? 'default'
          : failedIdx % 2 === 0
            ? `stop ${(failedIdx / 2) | 0}`
            : `value ${((failedIdx - 1) / 2) | 0}`
    warnings.push(
      `["step"] arg ${failedIdx + 1} (${slotName}) failed to convert; whole step bails.`,
    )
    return null
  }
  return `step(${args.join(', ')})`
}

export const letHandler: ExprHandler = (v, warnings, recurse) => {
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
      warnings.push(
        `Malformed ["let"] expression: binding name at slot ${i} is ${typeof name}, expected string.`,
      )
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
    warnings.push(
      `["let"] duplicate binding name(s) ${duplicateNames
        .slice(0, 4)
        .map((d) => `"${d}"`)
        .join(
          ', ',
        )}${duplicateNames.length > 4 ? ` + ${duplicateNames.length - 4} more` : ''}. The LAST binding wins; earlier ones are silent dead code.`,
    )
  }
  const substituted = substituteVars(body, bindings)
  return recurse(substituted, warnings)
}

export const varHandler: ExprHandler = (v, warnings) => {
  // Bare `["var", "name"]` outside any `let` — invalid per spec.
  // Returning null surfaces it in the generic "Expression not
  // converted" warning at the bottom.
  warnings.push(`["var"] outside ["let"]: ${JSON.stringify(v).slice(0, 80)}`)
  return null
}

export const sliceHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox `["slice", input, start]` or `["slice", input, start, end]`.
  // Routes through xgis `slice(input, start[, end])` builtin.
  if (v.length < 3 || v.length > 4) {
    warnings.push(
      `Malformed ["slice"] expression: expected 2-3 arguments (input, start[, end]), got ${v.length - 1}.`,
    )
    return null
  }
  const parts = v.slice(1).map((a) => recurse(a, warnings))
  if (parts.some((p) => p === null)) return null
  return `slice(${parts.join(', ')})`
}

export const indexOfHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox `["index-of", needle, haystack]` or
  // `["index-of", needle, haystack, from_index]`.
  if (v.length < 3 || v.length > 4) {
    warnings.push(
      `Malformed ["index-of"] expression: expected 2-3 arguments (needle, haystack[, from_index]), got ${v.length - 1}.`,
    )
    return null
  }
  const parts = v.slice(1).map((a) => recurse(a, warnings))
  if (parts.some((p) => p === null)) return null
  // xgis identifier names can't contain hyphens; route to the
  // underscore-bridged builtin which the evaluator binds.
  return `index_of(${parts.join(', ')})`
}

export const numberFormatHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox `["number-format", input, { locale?, currency?,
  // "min-fraction-digits"?, "max-fraction-digits"? }]`. xgis has
  // no object literal in source syntax, so flatten to a positional
  // call:  number_format(input, minFrac, maxFrac, locale, currency).
  // Absent fields lower to `null` literals — the evaluator treats
  // null as "use spec default" for each slot.
  if (v.length !== 3) {
    warnings.push(
      `Malformed ["number-format"] expression: expected 2 arguments (input, options), got ${v.length - 1}.`,
    )
    return null
  }
  const input = recurse(v[1], warnings)
  if (input === null) return null
  const opts = v[2]
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    warnings.push(
      `["number-format"] options arg must be a literal object: ${JSON.stringify(opts).slice(0, 80)}`,
    )
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

export const rgbHandler: ExprHandler = (v, warnings, _recurse, _recurseFilter, op) => {
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
    warnings.push(
      `["${op}"] expected ${requiredCh} channels, got ${ch.length}: ${JSON.stringify(v).slice(0, 80)}`,
    )
    return null
  }
  // Number.isFinite gate — NaN passes typeof; Math.round(NaN) is
  // NaN; `(NaN).toString(16)` is "NaN" → emitted hex literal
  // would be `#NaNNaNNaN` which the runtime parseHexColor regex
  // rejects, silently collapsing the colour to opaque black.
  const allNumeric = ch.every((c) => typeof c === 'number' && Number.isFinite(c))
  if (allNumeric) {
    const [r, g, b, a] = ch as number[]
    const cl = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
    const hex = (n: number) => cl(n).toString(16).padStart(2, '0')
    return op === 'rgb'
      ? `#${hex(r)}${hex(g)}${hex(b)}`
      : `#${hex(r)}${hex(g)}${hex(b)}${hex(Math.round(a * 255))}`
  }
  warnings.push(
    `["${op}"] with non-constant channels not converted: ${JSON.stringify(v).slice(0, 80)}`,
  )
  return null
}
