import { resolveColor } from '../tokens/colors'

/** Mapbox colour value → xgis colour fragment (the bit between
 *  `fill-` / `stroke-` and any trailing modifiers).
 *
 *  Accepts:
 *   - Hex literal (`#abcdef`, `#abc`, `#abcdef33`) — passes through.
 *   - CSS function form (`rgb(…)`, `rgba(…)`, `hsl(…)`, `hsla(…)`) —
 *     resolved to hex via the compiler's `resolveColor`. The xgis
 *     lexer can't parse parens inside utility names, so a `fill-
 *     hsla(0,60%,87%,0.23)` would break, but `fill-#abcdef33` is
 *     fine.
 *   - Mapbox tuple-style (`["rgb", r, g, b]`, `["rgba", r, g, b, a]`)
 *     — same hex resolution.
 *
 *  Returns null + emits a warning for anything else (interpolate,
 *  match, …) so the caller falls back to a more permissive path. */
export function colorToXgis(v: unknown, warnings: string[]): string | null {
  if (v == null) return null
  // Mapbox v8 wraps constants in `["literal", …]` so the inner value
  // can't be mistaken for an expression. Unwrap before the type
  // dispatch so `["literal", "#fff"]` lowers to the same constant
  // path as a bare "#fff". Without this the literal shape fell to
  // the "Color expression not converted" warning and the caller
  // routed it through exprToXgis as a quoted string — emitted a
  // data-driven `fill-["#fff"]` bracket binding instead of the
  // constant `fill-#fff` utility, paying per-feature eval cost for
  // a constant value.
  if (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  // `["to-color", "#fff"]` — Mapbox v8 type-coercion wrapper. The
  // evaluator passes through to the inner value at runtime; the
  // converter can drop the wrapper for the constant case so the
  // resulting fill / stroke emits as a direct hex utility instead of
  // collapsing to a bracket-binding data-driven path through
  // exprToXgis. (`to-color` of an expression — e.g. `["to-color",
  // ["get", "color"]]` — still needs the data-driven route.)
  // Accept BOTH bare string inner (`["to-color", "#fff"]`) AND v8
  // double-wrap `["to-color", ["literal", "#fff"]]` — strict tooling
  // emits the latter shape. Pre-fix the double-wrap fell to "Color
  // expression not converted" because the inner array failed the
  // typeof === 'string' gate.
  if (Array.isArray(v) && v.length === 2 && v[0] === 'to-color') {
    let inner = v[1]
    if (Array.isArray(inner) && inner.length === 2 && inner[0] === 'literal') {
      inner = inner[1]
    }
    if (typeof inner === 'string') v = inner
  }
  if (typeof v === 'string') {
    if (v.startsWith('#')) return v
    const hex = resolveColor(v.trim())
    if (hex) return hex
    return v
  }
  // Unwrap v8 strict `["literal", N]` per-channel wrappers so a
  // double-wrapped tuple like `["rgba", ["literal", 255], ["literal", 0],
  // ["literal", 0], ["literal", 0.5]]` still resolves to a constant hex.
  // Pre-fix any wrapped channel landed as a stringified array inside
  // the CSS-function expression, resolveColor failed, and the layer
  // fell to the data-driven bracket path or null.
  const unwrapChan = (x: unknown): unknown =>
    Array.isArray(x) && x.length === 2 && x[0] === 'literal' ? x[1] : x
  if (Array.isArray(v) && v[0] === 'rgba' && v.length === 5) {
    const r = unwrapChan(v[1])
    const g = unwrapChan(v[2])
    const b = unwrapChan(v[3])
    const a = unwrapChan(v[4])
    const A = typeof a === 'number' ? a : 1
    const hex = resolveColor(`rgba(${r}, ${g}, ${b}, ${A})`)
    if (hex) return hex
  }
  if (Array.isArray(v) && v[0] === 'rgb' && v.length === 4) {
    const r = unwrapChan(v[1])
    const g = unwrapChan(v[2])
    const b = unwrapChan(v[3])
    const hex = resolveColor(`rgb(${r}, ${g}, ${b})`)
    if (hex) return hex
  }
  // `["hsla", h, s, l, a]` / `["hsl", h, s, l]` array forms — Mapbox
  // spec accepts both. s + l carry the implicit % unit in the
  // function form (50 means 50%), so we re-wrap them when stitching
  // the CSS string. Per-channel literal unwrap mirrors the rgb path.
  if (Array.isArray(v) && v[0] === 'hsla' && v.length === 5) {
    const h = unwrapChan(v[1])
    const s = unwrapChan(v[2])
    const l = unwrapChan(v[3])
    const a = unwrapChan(v[4])
    const A = typeof a === 'number' ? a : 1
    const hex = resolveColor(`hsla(${h}, ${s}%, ${l}%, ${A})`)
    if (hex) return hex
  }
  if (Array.isArray(v) && v[0] === 'hsl' && v.length === 4) {
    const h = unwrapChan(v[1])
    const s = unwrapChan(v[2])
    const l = unwrapChan(v[3])
    const hex = resolveColor(`hsl(${h}, ${s}%, ${l}%)`)
    if (hex) return hex
  }
  warnings.push(`Color expression not converted: ${JSON.stringify(v).slice(0, 120)}`)
  return null
}
