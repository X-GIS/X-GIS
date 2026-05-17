// Mapbox `paint` properties → xgis utility-class array. One add*
// helper per supported property; each accepts the raw Mapbox value
// (constant / interpolate / expression) and pushes 0 or more
// utility strings onto `out`.
//
// Zoom-driven values (Mapbox `["interpolate", curve, ["zoom"], …]`)
// are wrapped into a single `interpolate(zoom, …)` xgis builtin
// inside a bracket binding — see `interpolateZoomCall` below.
// Non-zoom interpolate falls through to per-feature data-driven
// path handled by `exprToXgis`.

import type { MapboxLayer } from './types'
import { colorToXgis } from './colors'
import { exprToXgis } from './expressions'
import { maybeBracket } from './utils'

/** Unwrap Mapbox v8's `["literal", value]` wrapper for any scalar /
 *  array stop value or paint scalar input. The callbacks downstream
 *  type-check against the inner concrete type (number / string / array)
 *  and reject the wrapper as "not the shape I expected"; unwrapping
 *  eagerly lets a uniform code path handle both the bare and v8-
 *  strict forms. */
function unwrapStopLiteral(v: unknown): unknown {
  if (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    return v[1]
  }
  return v
}

/** Consolidated "ignored paint property" diagnostic. Pushes ONE
 *  warning per layer listing every property that's been declared but
 *  isn't honoured by the runtime today. Mirror of the symbol-layer
 *  `ignoredText` block in layers.ts — one warning per layer keeps
 *  the conversion-notes section readable while still surfacing every
 *  gap. Callers pass the list of property names that the layer
 *  TYPE doesn't currently process. */
function surfaceIgnoredPaint(
  layerId: string,
  paint: Record<string, unknown>,
  warnings: string[],
  candidates: readonly string[],
): void {
  const hits: string[] = []
  for (const k of candidates) {
    if (paint[k] !== undefined) hits.push(k)
  }
  if (hits.length > 0) {
    warnings.push(`Layer "${layerId}" — ignored paint properties: ${hits.join(', ')}`)
  }
}

export function paintToUtilities(layer: MapboxLayer, warnings: string[]): string[] {
  const out: string[] = []
  const p = layer.paint ?? {}

  if (layer.type === 'fill') {
    addFill(out, p['fill-color'], warnings)
    addOpacity(out, p['fill-opacity'], warnings)
    addFillOutline(out, p['fill-outline-color'], warnings)
    // Bitmap-fill rendering (sprite atlas) is Batch 2 roadmap work.
    // Surface the gap explicitly when a layer's ONLY visual cue is a
    // pattern: without this, the layer collapses to fill: none and
    // dead-layer-elim eliminates it silently. OFM Liberty's
    // `landcover_wetland` + `road_area_pattern` are the canonical
    // cases. Warns when fill-pattern is present AND no fill-color is
    // authored — the pattern-augmented case (fill-color + fill-pattern)
    // still renders the colour today.
    if (p['fill-pattern'] !== undefined && p['fill-color'] === undefined) {
      warnings.push(`Layer "${layer.id}" — fill-pattern declared without fill-color; the layer's only visual is a bitmap fill which is not yet supported (Batch 2 — sprite atlas). The layer will render empty until the atlas pipeline lands.`)
    }
    surfaceIgnoredPaint(layer.id, p, warnings, [
      'fill-translate', 'fill-translate-anchor', 'fill-sort-key',
    ])
  } else if (layer.type === 'line') {
    addStroke(out, p['line-color'], warnings)
    addStrokeWidth(out, p['line-width'], warnings)
    addStrokeDash(out, p['line-dasharray'], warnings)
    addOpacity(out, p['line-opacity'], warnings)
    addLineOffset(out, p['line-offset'], warnings)
    addLineBlur(out, p['line-blur'], warnings)
    // Same gap as fill-pattern: when a line layer's only visual is a
    // repeating sprite (no line-color), the layer goes dead silently.
    if (p['line-pattern'] !== undefined && p['line-color'] === undefined) {
      warnings.push(`Layer "${layer.id}" — line-pattern declared without line-color; the layer's only visual is a bitmap stroke which is not yet supported (Batch 2 — sprite atlas). The layer will render empty until the atlas pipeline lands.`)
    }
    surfaceIgnoredPaint(layer.id, p, warnings, [
      'line-translate', 'line-translate-anchor', 'line-sort-key',
      'line-gap-width', 'line-round-limit', 'line-gradient',
    ])
  } else if (layer.type === 'fill-extrusion') {
    addFill(out, p['fill-extrusion-color'], warnings)
    addOpacity(out, p['fill-extrusion-opacity'], warnings)
    addExtrudeHeight(out, p['fill-extrusion-height'], warnings)
    addExtrudeBase(out, p['fill-extrusion-base'], warnings)
    // `fill-extrusion-base` IS converted to an xgis utility and IR
    // node, but the polygon vertex shader (renderer.ts vs_main_quantized
    // line 317 + vs_main_extruded_quantized line 390) currently anchors
    // the bottom of every wall at z=0 unconditionally. So a non-zero
    // base authored in a fill-extrusion-base loses its wall-base offset
    // at render time — the building doesn't "float" above the ground
    // plane the way MapLibre would render it. Surface so style authors
    // know the geometry path doesn't yet read the base value, even
    // though the IR carries it.
    const baseVal = unwrapLiteralNumeric(p['fill-extrusion-base'])
    const baseIsNonZero = typeof baseVal === 'number'
      ? baseVal > 0
      : baseVal !== undefined  // expression / interpolate-by-zoom assumed non-trivial
    if (baseIsNonZero) {
      warnings.push(`Layer "${layer.id}" — fill-extrusion-base declared but the polygon vertex shader doesn't yet honour the wall-base offset (renderer.ts line 317); the wall renders flush with z=0 regardless of the authored base.`)
    }
    surfaceIgnoredPaint(layer.id, p, warnings, [
      'fill-extrusion-translate', 'fill-extrusion-translate-anchor',
      'fill-extrusion-pattern', 'fill-extrusion-vertical-gradient',
      'fill-extrusion-ambient-occlusion-intensity',
      'fill-extrusion-ambient-occlusion-radius',
    ])
  } else if (layer.type === 'raster') {
    // raster-opacity reuses the layer-uniform `opacity` resolver path
    // every other layer type goes through — same interpolate(zoom, …)
    // + constant + data-driven shapes all work. The runtime side
    // multiplies the sampled texel by the resolved opacity in the
    // raster fragment shader so the basemap shaded-relief styles
    // (OFM Liberty's `natural_earth`) fade out at higher zooms the
    // way they do in MapLibre.
    addOpacity(out, p['raster-opacity'], warnings)
    surfaceIgnoredPaint(layer.id, p, warnings, [
      'raster-hue-rotate', 'raster-brightness-min', 'raster-brightness-max',
      'raster-saturation', 'raster-contrast',
      'raster-fade-duration', 'raster-resampling',
    ])
  }

  return out
}

// ─── interpolate-by-zoom support ─────────────────────────────────────

interface InterpolateZoomShape {
  /** Mapbox interpolate curve. `'linear'` (default) emits the existing
   *  `interpolate(zoom, …)` xgis form; `'exponential'` emits
   *  `interpolate_exp(zoom, base, …)` which the lower pass detects
   *  and stores alongside the stops so the runtime can apply the
   *  same accelerated curve Mapbox would. */
  curve: 'linear' | 'exponential'
  /** Curve base — meaningful only when `curve === 'exponential'`.
   *  Default 1 (= linear) for the linear branch; explicit value for
   *  the exponential branch. */
  base: number
  stops: Array<{ zoom: number; value: unknown }>
}

/** Pull the curve type + stops out of an `["interpolate", curve,
 *  ["zoom"], z1, v1, …]` expression. Returns null when the shape
 *  doesn't match (non-zoom input, missing stops, etc.) so callers
 *  can short-circuit and route through the generic expression
 *  converter instead.
 *
 *  Cubic-bezier curves fall back to linear with a warning — xgis has
 *  no per-stop control-point evaluator yet. */
function interpolateZoomStops(
  v: unknown,
  warnings?: string[],
): InterpolateZoomShape | null {
  // Legacy stops shape (Mapbox style spec v0 / v1, still emitted by
  // many older styles — incl. the MapLibre demo basemap):
  //   { "stops": [[zoom, value], …], "base"?: number }
  // Modern equivalent:
  //   ["interpolate", ["exponential", base], ["zoom"], zoom, value, …]
  // Lift the legacy shape into the same InterpolateZoomShape so all
  // downstream emit/lower code (interpolate_exp / interpolate-zoom-
  // color stops / etc.) sees one canonical form. Without this lift,
  // every legacy-style line-width / fill-color / text-size silently
  // collapsed to its default in the converter output.
  if (
    v !== null && typeof v === 'object' && !Array.isArray(v)
    && Array.isArray((v as { stops?: unknown }).stops)
  ) {
    const rawStops = (v as { stops: unknown[] }).stops
    const legacyStops: Array<{ zoom: number; value: unknown }> = []
    for (const s of rawStops) {
      if (!Array.isArray(s) || s.length < 2 || typeof s[0] !== 'number') return null
      legacyStops.push({ zoom: s[0], value: unwrapStopLiteral(s[1]) })
    }
    if (legacyStops.length < 2) return null
    const rawBase = (v as { base?: unknown }).base
    const base = typeof rawBase === 'number' && rawBase !== 1 ? rawBase : 1
    return {
      curve: base === 1 ? 'linear' : 'exponential',
      base,
      stops: legacyStops,
    }
  }

  // `interpolate-lab` / `interpolate-hcl` (Mapbox v3 perceptually-uniform
  // colour interp in CIELAB / CIEHCL space) accepted as a graceful
  // downgrade to linear-RGB interpolation. X-GIS doesn't have a per-
  // stop colour-space evaluator yet, so falling back to linear is the
  // same loss-prevention pattern cubic-bezier already uses below.
  if (!Array.isArray(v)) return null
  if (v[0] !== 'interpolate' && v[0] !== 'interpolate-lab' && v[0] !== 'interpolate-hcl') return null
  if ((v[0] === 'interpolate-lab' || v[0] === 'interpolate-hcl') && warnings) {
    warnings.push(`${v[0]}(…) approximated as linear-RGB — xgis has no LAB/HCL per-stop evaluator yet.`)
  }
  const curveSpec = v[1]
  // Element 2 must be the `zoom` accessor.
  const input = v[2]
  if (!Array.isArray(input) || input[0] !== 'zoom') return null
  const stops: Array<{ zoom: number; value: unknown }> = []
  for (let i = 3; i + 1 < v.length; i += 2) {
    const z = v[i]
    if (typeof z !== 'number') return null
    // Mapbox v8 allows each stop's value to be wrapped in `["literal",
    // …]`. Unwrap eagerly so the numeric / colour callbacks
    // downstream see the bare value — without this each
    // `(val) => typeof val === 'number' ? String(val) : null` callback
    // returns null on the wrap and the whole interpolate fails.
    stops.push({ zoom: z, value: unwrapStopLiteral(v[i + 1]) })
  }
  if (stops.length < 2) return null

  let curve: 'linear' | 'exponential' = 'linear'
  let base = 1
  if (Array.isArray(curveSpec)) {
    if (curveSpec[0] === 'exponential' && typeof curveSpec[1] === 'number') {
      // base === 1 is mathematically identical to linear; collapse so
      // the runtime takes the cheaper code path.
      if (curveSpec[1] !== 1) {
        curve = 'exponential'
        base = curveSpec[1]
      }
    } else if (curveSpec[0] === 'cubic-bezier') {
      // No cubic-bezier evaluator yet; warn loudly so the user knows
      // the output is approximated as linear.
      warnings?.push(`["interpolate", ["cubic-bezier", …], ["zoom"], …] folded to linear — xgis has no per-stop bezier interpolator.`)
    }
  }
  return { curve, base, stops }
}

/** Render a Mapbox interpolate-by-zoom expression as an xgis
 *  `interpolate(zoom, …)` or `interpolate_exp(zoom, base, …)` call.
 *  The xgis evaluator handles the builtin uniformly — zoom-driven
 *  values evaluate per-frame, feature-driven values evaluate per-
 *  feature. Caller supplies an `emitValue` strategy that formats
 *  each stop value (colour, number, expression) into the bit that
 *  follows its zoom key.
 *
 *  Returns null when any stop value can't be formatted, so the
 *  caller can fall back to a more permissive path (e.g. take the
 *  first stop, or drop the property entirely). */
export function interpolateZoomCall(
  v: unknown,
  warnings: string[],
  emitValue: (val: unknown, warnings: string[]) => string | null,
): string | null {
  const shape = interpolateZoomStops(v, warnings)
  if (!shape) return null
  const parts: string[] = []
  for (const s of shape.stops) {
    const out = emitValue(s.value, warnings)
    if (out === null) return null
    parts.push(`${s.zoom}, ${out}`)
  }
  if (shape.curve === 'exponential') {
    return `interpolate_exp(zoom, ${shape.base}, ${parts.join(', ')})`
  }
  return `interpolate(zoom, ${parts.join(', ')})`
}

// ─── per-property emitters ───────────────────────────────────────────

function addFill(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  const interp = interpolateZoomCall(v, warnings, (val, w) => colorToXgis(val, w))
  if (interp !== null) {
    out.push(`fill-[${interp}]`)
    return
  }
  const s = colorToXgis(v, warnings)
  if (s) {
    out.push(`fill-${s}`)
    return
  }
  // Per-feature data-driven shape (`match` / `case` / etc.) — route
  // through the generic expression converter. Without this fallback
  // the MapLibre demo's `countries-fill` (`["match", ["get",
  // "ADM0_A3"], …, default]`) silently dropped fill-color: the
  // constant-only path returned null and the layer rendered without
  // a fill. lower.ts now extracts the match default arm as a
  // constant fallback when the runtime per-feature fill pipeline
  // isn't yet wired.
  const expr = exprToXgis(v, warnings)
  if (expr !== null) out.push(`fill-[${expr}]`)
}

function addStroke(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
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

/** Mapbox `paint.fill-outline-color` → xgis `stroke-<color> stroke-1`
 *  on the same fill layer. The xgis polygon renderer paints an outline
 *  in the same pass when a stroke is declared alongside a fill, so the
 *  Mapbox semantic ("fill + 1px outline") maps 1:1 with no extra
 *  layer. Pre-fix this property was silently dropped — OFM Bright
 *  layers like `landcover-wood`, `building-top`, and `highway-area`
 *  lost their declared outlines, producing visibly mushy boundaries
 *  vs MapLibre's reference rendering.
 *
 *  Mapbox spec defaults the outline width to 1 px; we emit `stroke-1`
 *  unconditionally when an outline colour is present so the runtime
 *  has a non-zero width to render (otherwise the stroke renderer
 *  skips the layer entirely). */
function addFillOutline(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  const interp = interpolateZoomCall(v, warnings, (val, w) => colorToXgis(val, w))
  if (interp !== null) {
    out.push(`stroke-[${interp}]`)
    out.push('stroke-1')
    return
  }
  const s = colorToXgis(v, warnings)
  if (s) {
    out.push(`stroke-${s}`)
    out.push('stroke-1')
    return
  }
  // Per-feature data-driven outline colour (`["match", ["get","class"], …]`).
  // Mirror of addStroke's data-driven fallback (the standalone line-color
  // path) — without this the outline silently dropped, leaving the fill
  // un-outlined even though the style declared the colour. Routes through
  // `stroke.colorExpr` via the lower pass's match-default-colour arm.
  const expr = exprToXgis(v, warnings)
  if (expr !== null) {
    out.push(`stroke-[${expr}]`)
    out.push('stroke-1')
  }
}

/** Unwrap Mapbox v8's `["literal", value]` wrapper for numeric paint
 *  helpers. The downstream `typeof === 'number'` shortcut fires only
 *  on the bare numeric form; without this unwrap a v8-wrapped numeric
 *  fell through to exprToXgis and emitted a bracket-binding form
 *  with the inner number as a quoted string. Mirror of the literal-
 *  unwrap pattern in colorToXgis (e3c5c62) and addOpacity (718d21a). */
function unwrapLiteralNumeric(v: unknown): unknown {
  if (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    return v[1]
  }
  return v
}

function addStrokeWidth(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  v = unwrapLiteralNumeric(v)
  // Mapbox spec: line-width >= 0. Clamp negative literals at convert
  // time — otherwise `addStrokeWidth(-5)` would emit `stroke--5`,
  // a double-dash utility name the parser splits incorrectly. Lower
  // priority than the opacity-clamp (negative widths are even rarer
  // in real styles) but the malformed output crashes the layer.
  if (typeof v === 'number') {
    const clamped = Math.max(0, v)
    out.push(`stroke-${clamped}`)
    return
  }
  const interp = interpolateZoomCall(v, warnings, (val) => typeof val === 'number' ? String(Math.max(0, val)) : null)
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
  if (v === undefined) return
  v = unwrapLiteralNumeric(v)
  if (typeof v === 'number') {
    if (v === 0) return
    if (v > 0) out.push(`stroke-offset-right-${v}`)
    else out.push(`stroke-offset-left-${-v}`)
    return
  }
  // Non-constant — interpolate-by-zoom or per-feature expression.
  // No binding-form handler in lower.ts yet; warn and skip.
  warnings.push(`paint.line-offset: non-constant form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
}

/** Mapbox `paint.line-blur` (edge feathering, CSS px) → xgis
 *  `stroke-blur-N`. The line shader's `aa_width_px` uniform absorbs
 *  the blur as both geometry expansion AND smoothstep widening, so a
 *  blur of N px soft-fades the edge over `1.5 + N` px each side. */
function addLineBlur(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  v = unwrapLiteralNumeric(v)
  if (typeof v === 'number') {
    if (v <= 0) return
    out.push(`stroke-blur-${v}`)
    return
  }
  warnings.push(`paint.line-blur: non-constant form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
}

function addStrokeDash(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  // Mapbox v8 `["literal", [4, 2]]` wrapper — unwrap to the inner
  // array before the numeric-array check so the modern form behaves
  // identically to the legacy bare `[4, 2]` shape.
  if (Array.isArray(v) && v.length === 2 && v[0] === 'literal' && Array.isArray(v[1])) {
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
      const nums = v.filter(n => typeof n === 'number')
      if (nums.length >= 2) {
        out.push('stroke-dasharray-' + nums.join('-'))
        return
      }
    }
    // Otherwise fall through to the warning.
  }
  // `["interpolate", curve, ["zoom"], z1, [a,b], …]` is the canonical
  // zoom-interp dasharray shape; the IR currently has no binding-form
  // arm for it (mirror of stroke-offset / line-blur). Drop with a
  // warning so the gap is visible in conversion notes rather than
  // silently producing an undashed line — matches addLineOffset /
  // addLineBlur behaviour for the same not-yet-supported case.
  warnings.push(`paint.line-dasharray: non-constant form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
}

function addOpacity(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  // See unwrapLiteralNumeric — covers `["literal", 0.5]` so the
  // scalar-scale conversion fires. Sibling to colorToXgis literal
  // unwrap (e3c5c62).
  v = unwrapLiteralNumeric(v)
  if (typeof v === 'number') {
    // Mapbox spec: opacity ∈ [0, 1]. Clamp at convert time so a
    // typo'd negative or > 1 value doesn't produce a malformed
    // utility name (`opacity--50` lexes as an utility name with
    // double-dash that the parser splits on the wrong segment).
    const clamped = Math.max(0, Math.min(1, v <= 1 ? v : v / 100))
    out.push(`opacity-${Math.round(clamped * 100)}`)
    return
  }
  const interp = interpolateZoomCall(v, warnings, (val) => {
    if (typeof val !== 'number') return null
    // Mapbox opacity is 0..1; xgis opacity utility takes 0..100.
    // Scale here so the stops match the utility's scale.
    return String(val <= 1 ? Math.round(val * 100) : val)
  })
  if (interp !== null) {
    out.push(`opacity-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) out.push(`opacity-${maybeBracket(x)}`)
}

function addExtrudeHeight(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  v = unwrapLiteralNumeric(v)
  const interp = interpolateZoomCall(v, warnings, (val, w) => exprToXgis(val, w))
  if (interp !== null) {
    out.push(`fill-extrusion-height-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) out.push(`fill-extrusion-height-${maybeBracket(x)}`)
}

function addExtrudeBase(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  v = unwrapLiteralNumeric(v)
  const interp = interpolateZoomCall(v, warnings, (val, w) => exprToXgis(val, w))
  if (interp !== null) {
    out.push(`fill-extrusion-base-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) out.push(`fill-extrusion-base-${maybeBracket(x)}`)
}
