// Mapbox `line` layer paint → xgis utilities. Per-type emitter group
// extracted from paint.ts; called by the thin dispatcher in paint.ts
// in the exact same order. Shared emitters (addOpacity / vec2AxisZoomInterp
// / surfaceIgnoredPaint) live in paint-helpers.
import type { MapboxLayer } from './types'
import { colorToXgis } from './colors'
import { exprToXgis } from './expressions'
import { maybeBracket } from './utils'
import {
  isOmitted,
  unwrapLiteralNumeric,
  interpolateZoomCall,
  addOpacity,
  addTranslateAnchor,
  vec2AxisZoomInterp,
  surfaceIgnoredPaint,
} from './paint-helpers'

export function emitLinePaint(
  out: string[],
  layer: MapboxLayer,
  p: Record<string, unknown>,
  warnings: string[],
): void {
  addStroke(out, p['line-color'], warnings)
  addStrokeWidth(out, p['line-width'], warnings)
  addStrokeDash(out, p['line-dasharray'], warnings)
  addOpacity(out, p['line-opacity'], warnings)
  addLineOffset(out, p['line-offset'], warnings)
  addLineBlur(out, p['line-blur'], warnings)
  addLineGapWidth(out, p['line-gap-width'], warnings)
  // iter-178 — line-pattern Stage 1 (parallel to iter-177 fill-
  // pattern). Constant string emit only; runtime resolves sprite
  // centre pixel as line colour at draw time. Stage 2 (real
  // repeating-sprite stroke renderer) deferred. NOTE: line-pattern
  // rides a DISTINCT `stroke-image-` utility — NOT `stroke-pattern-`
  // — because `stroke-pattern-<bareshape>` is already the native
  // X-GIS SDF dash-symbol namespace (railroad/fence/marker/…), and
  // colliding with it routed the sprite into the dash path where it
  // was silently dropped. `stroke-image-<sprite>` keeps the two apart.
  if (p['line-pattern'] !== undefined && p['line-pattern'] !== null) {
    const v = p['line-pattern']
    if (typeof v === 'string') {
      out.push(`stroke-image-${v}`)
    } else {
      warnings.push(`Layer "${layer.id}" — line-pattern non-constant form (expression / interpolate) not yet wired through the IR; the constant string form is supported (iter-178). The layer falls back to line-color or transparent.`)
    }
  }
  // line-gradient — value-aware: when present, surface the specific
  // gap reason (needs line-progress accessor) instead of the
  // generic ignored-properties warn. Removed from surfaceIgnoredPaint
  // candidates so the specific message isn't duplicated.
  if (p['line-gradient'] !== undefined && p['line-gradient'] !== null) {
    warnings.push(`Layer "${layer.id}" — line-gradient set but requires the line-progress accessor + per-fragment arc-length varying through the line renderer; not implemented (Plan §4 deferred). Layer falls back to solid line-color.`)
  }
  addLineTranslate(out, p['line-translate'], warnings)
  // line-translate-anchor: viewport (default) = screen-space (today's
  // behaviour). map → world-space offset rotating with map bearing.
  // The line layer's translate rides the `stroke-translate-*` utility
  // namespace, so the anchor flag uses the 'stroke' prefix too.
  addTranslateAnchor(out, 'stroke', p['line-translate-anchor'], p['line-translate'], warnings)
  surfaceIgnoredPaint(layer.id, p, warnings, [
    // line-round-limit + line-translate-anchor are now implemented (Phase S
    // Batch 2); line-sort-key remains the only ignored line paint prop.
    'line-sort-key',
  ])
}

function addStroke(out: string[], v: unknown, warnings: string[]): void {
  // Same null-as-omit treatment as addFill.
  if (isOmitted(v)) return
  const interp = interpolateZoomCall(v, warnings, (val, w) => colorToXgis(val, w))
  if (interp !== null) {
    out.push(`stroke-[${interp}]`)
    return
  }
  const s = colorToXgis(v, warnings)
  if (s) {
    out.push(`stroke-${s}`)
    return
  }
  // Per-feature data-driven shape (`match` / `case` / etc.) — mirror
  // of the addFill fallback. Without this branch, a stroke colour
  // expression like `["match", ["get", "class"], "primary", "#f00",
  // "#000"]` silently dropped: colorToXgis returns null on the
  // expression form, and addStroke used to bail. The line renderer
  // already evaluates synthesised match() ASTs per feature via the
  // worker's segment buffer slot, so the runtime side accepts the
  // bracket-binding form on emission.
  const expr = exprToXgis(v, warnings)
  if (expr !== null) out.push(`stroke-[${expr}]`)
}

function addStrokeWidth(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  v = unwrapLiteralNumeric(v)
  // Mapbox spec: line-width >= 0. Clamp negative literals at convert
  // time — otherwise `addStrokeWidth(-5)` would emit `stroke--5`,
  // a double-dash utility name the parser splits incorrectly. Lower
  // priority than the opacity-clamp (negative widths are even rarer
  // in real styles) but the malformed output crashes the layer.
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Number.isFinite rejects NaN / Infinity: `typeof NaN === 'number'`
    // slipped past the type gate and `Math.max(0, NaN) = NaN` emitted
    // a literal `stroke-NaN` utility that the parser rejected.
    if (v < 0) {
      warnings.push(`paint.line-width: value ${v} is negative; Mapbox spec requires >= 0. Clamped to 0 (line won't render at this zoom).`)
    }
    const clamped = Math.max(0, v)
    out.push(`stroke-${clamped}`)
    return
  }
  const interp = interpolateZoomCall(v, warnings, (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
  if (interp !== null) {
    out.push(`stroke-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x === null) return
  // Tailwind-style suffix: number → `stroke-1.5`, expression → bracket form.
  out.push(`stroke-${maybeBracket(x)}`)
}

/** Mapbox `paint.line-offset` (parallel lateral shift, CSS px;
 *  positive = right of travel direction in Mapbox spec) → xgis
 *  `stroke-offset-right-N` / `stroke-offset-left-N`. The xgis line
 *  renderer already threads `strokeOffset` end-to-end (IR → vertex
 *  shader, including offset-aware miter/join geometry); the
 *  converter just needs to pick the right utility variant so the
 *  sign convention matches.
 *
 *  Sign mapping: Mapbox positive = right of travel; xgis
 *  `stroke-offset-right-N` lowers to `strokeOffset = -N` (right is
 *  negative in xgis's internal convention). Both ends agree on the
 *  visual side after the conversion.
 *
 *  Currently emits constant only. Interpolate-by-zoom / expression
 *  forms aren't yet lowered for stroke-offset (lower.ts has no
 *  binding-form arm for it); we surface a warning so callers know
 *  the gap. */
function addLineOffset(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  v = unwrapLiteralNumeric(v)
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Number.isFinite rejects NaN/Infinity (typeof NaN === 'number'
    // is true; sign-test against NaN falls neither > 0 nor < 0 and
    // emitted `stroke-offset-right-NaN` from the inversion fallback
    // on negative; finite gate avoids the malformed emit).
    if (v === 0) return
    if (v > 0) out.push(`stroke-offset-right-${v}`)
    else out.push(`stroke-offset-left-${-v}`)
    return
  }
  // Non-constant — interpolate-by-zoom or per-feature expression.
  // No binding-form handler in lower.ts yet; warn and skip.
  warnings.push(`paint.line-offset: non-constant form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
}

/** Mapbox `paint.line-gap-width` (gap WIDTH between two parallel
 *  lines, CSS px) → xgis `stroke-gap-N`. When non-zero the line
 *  draws as TWO parallel strokes (each stroke-width wide) with the
 *  gap between them — the typical road-casing visual.
 *
 *  Constant + interpolate-by-zoom both emit; non-constant non-zoom
 *  expressions defer and warn. Runtime route: ShowCommand.strokeGapWidth
 *  > 0 triggers two writeLayerSlot + drawSegments calls per line layer
 *  with offsets ±(gap+stroke)/2. OFM Liberty waterway_tunnel
 *  (zoom-interp 12→0, 20→6) is the only fixture hit. */
function addLineGapWidth(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  v = unwrapLiteralNumeric(v)
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Default 0 = no gap = single line; skip emit so the runtime
    // single-draw path stays unchanged.
    if (v <= 0) return
    out.push(`stroke-gap-${v}`)
    return
  }
  const interp = interpolateZoomCall(v, warnings,
    (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
  if (interp !== null) {
    out.push(`stroke-gap-[${interp}]`)
    return
  }
  warnings.push(`paint.line-gap-width: non-constant non-zoom form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
}

/** Mapbox `paint.line-translate: [dx, dy]` → xgis
 *  `stroke-translate-x-N stroke-translate-y-M` (signed pixel offsets).
 *  Mirrors addFillTranslate exactly — same constant + zoom-interp
 *  last-stop forms, same bracket-negative convention.
 *
 *  Sign convention: Mapbox positive x = right, positive y = down
 *  (screen space). The runtime WGSL negates y for NDC convention
 *  (NDC y is UP) — same as fill-translate.
 *
 *  Anchor: line-translate-anchor: viewport (default) is the only
 *  currently-honoured mode. "map" would shift in world coords; not
 *  yet implemented. */
function addLineTranslate(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  // Unwrap Mapbox v8 `["literal", [dx, dy]]` wrapper.
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  if (Array.isArray(v) && v.length === 2
      && typeof v[0] === 'number' && Number.isFinite(v[0])
      && typeof v[1] === 'number' && Number.isFinite(v[1])) {
    const fmt = (n: number): string => n < 0 ? `[${n}]` : `${n}`
    if (v[0] !== 0) out.push(`stroke-translate-x-${fmt(v[0])}`)
    if (v[1] !== 0) out.push(`stroke-translate-y-${fmt(v[1])}`)
    return
  }
  // WS-1 — per-frame zoom-interp via per-axis scalar PropertyShape
  // (mirrors fill-translate). Emit stroke-translate-{x,y}-[interpolate…]
  // bracket bindings → strokeTranslate{X,Y}Shape → per-frame resolve.
  if (Array.isArray(v) && v.length >= 4 && v[0] === 'interpolate') {
    const ix = vec2AxisZoomInterp(v, warnings, 0)
    const iy = vec2AxisZoomInterp(v, warnings, 1)
    if (ix !== null && iy !== null) {
      out.push(`stroke-translate-x-[${ix}]`)
      out.push(`stroke-translate-y-[${iy}]`)
      return
    }
  }
  warnings.push(`paint.line-translate: non-constant form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
}

/** Mapbox `paint.line-blur` (edge feathering, CSS px) → xgis
 *  `stroke-blur-N`. The line shader's `aa_width_px` uniform absorbs
 *  the blur as both geometry expansion AND smoothstep widening, so a
 *  blur of N px soft-fades the edge over `1.5 + N` px each side. */
function addLineBlur(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  v = unwrapLiteralNumeric(v)
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Number.isFinite rejects NaN/Infinity. NaN <= 0 is false, so
    // a NaN blur would fall through the v <= 0 skip and emit
    // `stroke-blur-NaN`.
    if (v < 0) {
      warnings.push(`paint.line-blur: value ${v} is negative; Mapbox spec requires >= 0. Clamped to 0 (line renders without blur).`)
    }
    if (v <= 0) return
    out.push(`stroke-blur-${v}`)
    return
  }
  warnings.push(`paint.line-blur: non-constant form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
}

function addStrokeDash(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  // Mapbox v8 `["literal", [4, 2]]` wrapper — unwrap to the inner
  // array before the numeric-array check so the modern form behaves
  // identically to the legacy bare `[4, 2]` shape.
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal' && Array.isArray(v[1])) {
    v = v[1]
  }
  if (Array.isArray(v)) {
    // Mapbox expression / interpolate shape — leading element is an
    // operator string ("interpolate", "step", "case", etc.). Don't
    // treat numeric children as dash values (the would-be filter
    // would silently match the zoom stops as a 2-element dash array).
    // Fall through to the warning path so the user sees the gap.
    // (`literal` is intentionally NOT in this list — the literal
    //  wrapper got unwrapped above.)
    const first = v[0]
    const looksLikeExpression = typeof first === 'string'
      && /^[a-z][a-z-]+$/.test(first)
      && /^(interpolate|interpolate-exp|interpolate-lab|interpolate-hcl|step|case|match|coalesce|to-number)$/.test(first)
    if (!looksLikeExpression) {
      // Mapbox spec: dash values are non-negative. Clamp at convert
      // time so a typo'd negative doesn't emit
      // `stroke-dasharray--4-2` (double-dash utility name) which the
      // parser splits incorrectly. Same class as the line-width /
      // opacity / text-size clamps.
      // Per-element v8 literal-wrap unwrap. Strict tooling can emit
      // `["literal", [["literal", 4], ["literal", 2]]]` — outer unwrap
      // above gave the inner array but each element may still be a
      // `["literal", 4]` scalar wrap. Without this, the typeof === 'number'
      // filter rejected every element and the dash silently dropped.
      const unwrapped = v.map(n => {
        while (Array.isArray(n) && n.length === 2 && n[0] === 'literal') n = n[1]
        return n
      })
      const nums = unwrapped.filter(n => typeof n === 'number').map(n => Math.max(0, n as number))
      // Surface partial-drop: a dash array with one non-numeric entry
      // (typo'd `[4, "two", 2]` from hand-edited JSON) would otherwise
      // silently emit a `stroke-dasharray-4-2` that doesn't match the
      // authored intent. Warn so the conversion notes record the gap.
      if (nums.length !== unwrapped.length) {
        warnings.push(`paint.line-dasharray: dropped ${unwrapped.length - nums.length} non-numeric entr${unwrapped.length - nums.length === 1 ? 'y' : 'ies'}; emitted dash pattern differs from authored value.`)
      }
      if (nums.length >= 2) {
        out.push('stroke-dasharray-' + nums.join('-'))
        return
      }
    }
    // Otherwise fall through to the warning.
  }
  // WS-1 — zoom-interp dasharray: emit a bracket binding the runtime
  // resolves per frame (PropertyShape<number[]>, STEPped — Mapbox
  // line-dasharray is interpolated:false). Each stop value is a numeric
  // array; format it back to an xgis array literal so lower.ts'
  // extractInterpolateZoomArrayStops picks it up.
  if (Array.isArray(v) && v.length >= 4 && v[0] === 'interpolate') {
    const interp = interpolateZoomCall(v, warnings, (val) => {
      let inner: unknown = val
      while (Array.isArray(inner) && inner.length === 2 && inner[0] === 'literal') inner = inner[1]
      if (Array.isArray(inner) && inner.length >= 2
          && inner.every(n => typeof n === 'number' && Number.isFinite(n))) {
        return '[' + (inner as number[]).map(n => Math.max(0, n)).join(', ') + ']'
      }
      return null
    })
    if (interp !== null) { out.push(`stroke-dasharray-[${interp}]`); return }
  }
  // Remaining non-constant shapes (data-driven, malformed) drop with a
  // warning so the gap is visible in conversion notes rather than
  // silently producing an undashed line — matches addLineOffset /
  // addLineBlur behaviour for the same not-yet-supported case.
  //
  // Specific shape detection so the warning explains WHICH gap fires:
  //   * ["interpolate", ...] → zoom-interp gap (PropertyShape<array>)
  //   * ["case", ...] / ["match", ...] / ["get", ...] → data-driven
  //   * anything else → generic non-constant
  let shape = 'non-constant'
  if (Array.isArray(v) && v.length > 0) {
    if (v[0] === 'interpolate' || v[0] === 'interpolate-lab' || v[0] === 'interpolate-hcl') {
      shape = 'zoom-interp (needs PropertyShape<array> variant)'
    } else if (v[0] === 'case' || v[0] === 'match' || v[0] === 'get' || v[0] === 'step') {
      shape = 'data-driven (needs per-feature dash plumbing)'
    }
  }
  warnings.push(`paint.line-dasharray: ${shape} form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
}
