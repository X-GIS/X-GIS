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
  // Loop unwrap so double-wraps like `["literal", ["literal", 0.5]]`
  // (rare, but emitted by some v8 strict preprocessor chains) peel
  // down to the inner scalar/array in one pass. Mirror of the loop
  // unwrap in colorToXgis (921d5ad).
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  return v
}

/** True when v should be treated as "property omitted" per Mapbox
 *  spec: bare null/undefined OR `["literal", null]`. Used by every
 *  paint helper's early-return gate to ensure null + v8-wrapped-null
 *  both fall to the default-emission path instead of leaking through
 *  as a runtime `null` identifier binding (commit a969be5). */
function isOmitted(v: unknown): boolean {
  if (v === undefined || v === null) return true
  // Loop peel so multi-wrapped null (`["literal", ["literal", null]]`)
  // also falls through to "omitted". Mirror of the loop unwrap in
  // colorToXgis (921d5ad) + unwrapStopLiteral (0532bc3). Pre-fix the
  // single-pass check missed double-wrapped nulls and they leaked
  // through to exprToXgis as `null` identifier bindings.
  let cur: unknown = v
  while (Array.isArray(cur) && cur.length === 2 && cur[0] === 'literal') {
    cur = cur[1]
  }
  return cur === null || cur === undefined
}

/** Consolidated "ignored paint property" diagnostic. Pushes ONE
 *  warning per layer listing every property that's been declared but
 *  isn't honoured by the runtime today. Mirror of the symbol-layer
 *  `ignoredText` block in layers.ts — one warning per layer keeps
 *  the conversion-notes section readable while still surfacing every
 *  gap. Callers pass the list of property names that the layer
 *  TYPE doesn't currently process. */
/** Mapbox spec: anchor properties have no effect without their parent
 *  translate. Skip the warning when the parent is absent — the layer's
 *  visual is unchanged regardless of our handling. landcover_wetland
 *  in openfreemap-liberty hits this (fill-translate-anchor: "map"
 *  with no fill-translate) so the iter 467 lossy report counted a
 *  spurious entry for that layer. */
const ANCHOR_PARENT: Record<string, string> = {
  'fill-translate-anchor': 'fill-translate',
  'line-translate-anchor': 'line-translate',
  'icon-translate-anchor': 'icon-translate',
  'text-translate-anchor': 'text-translate',
  'fill-extrusion-translate-anchor': 'fill-extrusion-translate',
}

/** Spec-default values where authoring the default matches X-GIS
 *  behaviour — no warning needed. Per-property lookup; the warn-only
 *  case is the gap-revealing value (e.g. fill-antialias=false). Keyed
 *  by property name; value is the spec default that suppresses warn.
 *  ["literal", v] wraps unwrapped before comparison.
 */
const SPEC_DEFAULT_NO_WARN: Record<string, unknown> = {
  'raster-resampling': 'linear',
  // *-translate-anchor: spec default 'map' for fill/line/circle/
  // fill-extrusion translate-anchor, but X-GIS today only implements
  // viewport-space translates (matches the 'viewport' value). Authors
  // writing 'viewport' explicitly match X-GIS behaviour — no warning.
  // 'map' is the real gap (would shift in world coords on bearing).
  'line-translate-anchor': 'viewport',
  'circle-translate-anchor': 'viewport',
  'fill-translate-anchor': 'viewport',
  'fill-extrusion-translate-anchor': 'viewport',
  // text-translate-anchor / icon-translate-anchor: same shape but
  // handled in the symbol layout path, not via surfaceIgnoredPaint.
  // Add future spec-defaults here when they enter surfaceIgnoredPaint.
  // fill-extrusion-vertical-gradient already handled inline because
  // its conditional is at the candidate-list site (cleaner there).
  // fill-antialias has its own value-aware emit before this fn.
}

function unwrapLiteralScalarLocal(v: unknown): unknown {
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
  return v
}

function surfaceIgnoredPaint(
  layerId: string,
  paint: Record<string, unknown>,
  warnings: string[],
  candidates: readonly string[],
): void {
  const hits: string[] = []
  for (const k of candidates) {
    // Both undefined AND null mean "property omitted" per Mapbox
    // spec — no warning needed when the author explicitly set it
    // to null to fall back to the default.
    if (paint[k] === undefined || paint[k] === null) continue
    // Anchor-dependency skip: a `*-translate-anchor` without its
    // parent `*-translate` has no observable effect (anchor only
    // controls the coordinate space of the translate).
    const parent = ANCHOR_PARENT[k]
    if (parent !== undefined && (paint[parent] === undefined || paint[parent] === null)) continue
    // Spec-default suppression: when the author explicitly sets the
    // spec default value AND that default matches X-GIS behaviour,
    // skip the warning (no actual gap to surface).
    const specDefault = SPEC_DEFAULT_NO_WARN[k]
    if (specDefault !== undefined && unwrapLiteralScalarLocal(paint[k]) === specDefault) continue
    hits.push(k)
  }
  if (hits.length > 0) {
    warnings.push(`Layer "${layerId}" — ignored paint properties: ${hits.join(', ')}`)
  }
}

export function paintToUtilities(layer: MapboxLayer, warnings: string[]): string[] {
  const out: string[] = []
  // Defensive: paint should be an object per spec. Non-object forms
  // (string from copy-paste, array, etc.) would otherwise let
  // `p['fill-color']` index a char or undefined. Mirror of the
  // expand-color-match guard.
  const rawPaint = (layer as { paint?: unknown }).paint
  const p = (rawPaint !== null && rawPaint !== undefined
    && typeof rawPaint === 'object' && !Array.isArray(rawPaint))
    ? rawPaint as Record<string, unknown>
    : {}

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
    // Treat fill-color === null the same as undefined per Mapbox spec
    // (null means "property omitted, use default"). Pre-fix only
    // undefined hit this branch — an authored `fill-color: null`
    // alongside a `fill-pattern` slipped past with no diagnostic
    // even though the layer's only visual cue (the pattern atlas)
    // isn't supported yet.
    if (p['fill-pattern'] !== undefined && p['fill-pattern'] !== null) {
      if (p['fill-color'] === undefined || p['fill-color'] === null) {
        warnings.push(`Layer "${layer.id}" — fill-pattern declared without fill-color; the layer's only visual is a bitmap fill which is not yet supported (Batch 2 — sprite atlas). The layer will render empty until the atlas pipeline lands.`)
      } else {
        // fill-pattern WITH fill-color: pattern silently dropped,
        // layer still renders with the solid colour fallback. Mirror
        // of the iter 43 line-pattern + line-color surface so the
        // author knows the pattern intent didn't land.
        warnings.push(`Layer "${layer.id}" — fill-pattern set alongside fill-color; pattern is dropped (Batch 2 sprite-atlas dependency) and the layer renders with the solid fill-color fallback.`)
      }
    }
    addFillTranslate(out, p['fill-translate'], warnings)
    // fill-antialias: default `true` matches X-GIS runtime (fragment
    // shader always anti-aliases edges via MSAA + smoothstep).
    // Explicit `false` is a real gap — Mapbox spec says edges should
    // be hard pixel-art steps; X-GIS can't disable AA per-layer yet
    // (would need a separate pipeline binding without MSAA). Warn
    // only on the false case so authors of pixel-art landcover
    // styles know why their land looks soft.
    const aaRaw = p['fill-antialias']
    const aa = Array.isArray(aaRaw) && aaRaw.length === 2 && aaRaw[0] === 'literal' ? aaRaw[1] : aaRaw
    if (aa === false) {
      warnings.push(`Layer "${layer.id}" — fill-antialias false: X-GIS runtime can't disable edge AA per layer yet (would need a no-MSAA pipeline binding). Layer renders smooth edges; Plan §3.1 deferred.`)
    }
    surfaceIgnoredPaint(layer.id, p, warnings, [
      'fill-translate-anchor', 'fill-sort-key',
    ])
  } else if (layer.type === 'line') {
    addStroke(out, p['line-color'], warnings)
    addStrokeWidth(out, p['line-width'], warnings)
    addStrokeDash(out, p['line-dasharray'], warnings)
    addOpacity(out, p['line-opacity'], warnings)
    addLineOffset(out, p['line-offset'], warnings)
    addLineBlur(out, p['line-blur'], warnings)
    addLineGapWidth(out, p['line-gap-width'], warnings)
    // Same gap as fill-pattern: when a line layer's only visual is a
    // repeating sprite (no line-color), the layer goes dead silently.
    // Mirror of the fill-pattern null-as-omit treatment above.
    if (p['line-pattern'] !== undefined && p['line-pattern'] !== null) {
      if (p['line-color'] === undefined || p['line-color'] === null) {
        warnings.push(`Layer "${layer.id}" — line-pattern declared without line-color; the layer's only visual is a bitmap stroke which is not yet supported (Batch 2 — sprite atlas). The layer will render empty until the atlas pipeline lands.`)
      } else {
        // line-pattern WITH line-color: pattern silently dropped,
        // layer still renders with the solid colour fallback. Surface
        // the gap so the author knows the pattern intent didn't land.
        warnings.push(`Layer "${layer.id}" — line-pattern set alongside line-color; pattern is dropped (Batch 2 sprite-atlas dependency) and the layer renders with the solid line-color fallback.`)
      }
    }
    // line-gradient — value-aware: when present, surface the specific
    // gap reason (needs line-progress accessor) instead of the
    // generic ignored-properties warn. Removed from surfaceIgnoredPaint
    // candidates so the specific message isn't duplicated.
    if (p['line-gradient'] !== undefined && p['line-gradient'] !== null) {
      warnings.push(`Layer "${layer.id}" — line-gradient set but requires the line-progress accessor + per-fragment arc-length varying through the line renderer; not implemented (Plan §4 deferred). Layer falls back to solid line-color.`)
    }
    // line-translate — fill-translate has a u.fill_translate_x/y
    // uniform; line-translate would mirror that via a
    // u.line_translate_x/y uniform threaded through line-renderer.ts
    // vertex shader. Surface the specific gap rather than the
    // generic ignored-properties blob.
    if (p['line-translate'] !== undefined && p['line-translate'] !== null) {
      warnings.push(`Layer "${layer.id}" — line-translate set but the line renderer has no per-frame translate uniform yet (Plan §4 deferred — mirror of fill-translate's u.fill_translate_x/y); offset is dropped.`)
    }
    surfaceIgnoredPaint(layer.id, p, warnings, [
      'line-translate-anchor', 'line-sort-key',
      'line-round-limit',
    ])
  } else if (layer.type === 'fill-extrusion') {
    addFill(out, p['fill-extrusion-color'], warnings)
    addOpacity(out, p['fill-extrusion-opacity'], warnings)
    addExtrudeHeight(out, p['fill-extrusion-height'], warnings)
    addExtrudeBase(out, p['fill-extrusion-base'], warnings)
    // fill-extrusion-base is now honored by the polygon vertex shader
    // (renderer.ts vs_main_quantized z_world select pulls
    // u.extrude_base_m as the wall bottom, iter 489 landed
    // 2026-05-18). Prior warning at this site is obsolete; uniform-
    // constant base lifts walls off z=0 as MapLibre does.
    //
    // fill-extrusion-vertical-gradient: special-case the default
    // (true) so authors who explicitly set the spec default don't
    // see a spurious "ignored" warning. false IS a real gap (runtime
    // always applies the gradient ramp) and stays in the
    // surfaceIgnoredPaint candidates list below.
    const vgRaw = p['fill-extrusion-vertical-gradient']
    const vg = Array.isArray(vgRaw) && vgRaw.length === 2 && vgRaw[0] === 'literal' ? vgRaw[1] : vgRaw
    const skipVerticalGradientWarn = vg === true || vg === undefined || vg === null
    // fill-extrusion-translate — mirror of line-translate + fill-
    // translate gap surfaces. fill-extrusion-vertex-shader has no
    // per-frame translate uniform yet.
    if (p['fill-extrusion-translate'] !== undefined && p['fill-extrusion-translate'] !== null) {
      warnings.push(`Layer "${layer.id}" — fill-extrusion-translate set but the fill-extrusion renderer has no per-frame translate uniform yet (Plan §4 deferred — mirror of fill-translate's u.fill_translate_x/y); offset is dropped.`)
    }
    // fill-extrusion-pattern: same atlas dependency as fill-pattern
    // / line-pattern. When fill-extrusion-color is also set, the
    // pattern silently drops and the layer renders the solid colour.
    // Surface the specific gap so authors who depend on textured
    // building walls see the diagnostic.
    if (p['fill-extrusion-pattern'] !== undefined && p['fill-extrusion-pattern'] !== null) {
      if (p['fill-extrusion-color'] === undefined || p['fill-extrusion-color'] === null) {
        warnings.push(`Layer "${layer.id}" — fill-extrusion-pattern declared without fill-extrusion-color; the layer's only visual is a bitmap wall fill which is not yet supported (Batch 2 — sprite atlas). The layer will render walls as uncoloured.`)
      } else {
        warnings.push(`Layer "${layer.id}" — fill-extrusion-pattern set alongside fill-extrusion-color; pattern is dropped (Batch 2 sprite-atlas dependency) and the walls render with the solid colour fallback.`)
      }
    }
    surfaceIgnoredPaint(layer.id, p, warnings, [
      'fill-extrusion-translate-anchor',
      ...(skipVerticalGradientWarn ? [] : ['fill-extrusion-vertical-gradient']),
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
    // raster-resampling: 'linear' (default) matches X-GIS — the sampler
    // is fixed to linear. 'nearest' is a real gap (pixel-art / DEM
    // staircase rendering); suppress the spec-default warn and only
    // surface the real gap.
    const rsRaw = p['raster-resampling']
    const rs = Array.isArray(rsRaw) && rsRaw.length === 2 && rsRaw[0] === 'literal' ? rsRaw[1] : rsRaw
    const skipResamplingWarn = rs === 'linear' || rs === undefined || rs === null
    surfaceIgnoredPaint(layer.id, p, warnings, [
      'raster-hue-rotate', 'raster-brightness-min', 'raster-brightness-max',
      'raster-saturation', 'raster-contrast',
      'raster-fade-duration',
      ...(skipResamplingWarn ? [] : ['raster-resampling']),
    ])
    if (rs === 'nearest') {
      warnings.push(`Layer "${layer.id}" — raster-resampling: nearest set but X-GIS sampler is fixed to linear (Plan §4 deferred — would need a separate nearest-sampler binding). Tiles render with linear filtering regardless.`)
    }
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
      if (!Array.isArray(s) || s.length < 2) return null
      // Unwrap v8 strict `["literal", N]` on the zoom key — same pattern
      // as the modern interpolate path. Pre-fix a wrapped zoom key
      // failed the typeof === 'number' gate and the legacy stops form
      // returned null, dropping the property to its default.
      const z = unwrapStopLiteral(s[0])
      // Number.isFinite rejects NaN — pre-fix a NaN zoom key (rare
      // but observed in malformed legacy v0/v1 styles where the
      // stop pair was hand-edited) landed in `legacyStops` as the
      // zoom value; downstream sort + bounds-clamp at the
      // interpolate evaluator returned NaN at every zoom, the
      // emitted utility silently collapsed.
      if (typeof z !== 'number' || !Number.isFinite(z)) return null
      legacyStops.push({ zoom: z, value: unwrapStopLiteral(s[1]) })
    }
    if (legacyStops.length < 2) return null
    const rawBase = (v as { base?: unknown }).base
    // Number.isFinite gate rejects NaN — `NaN !== 1` is true so a
    // typeof-only check would let a NaN base land in the IR as the
    // exponential curve's base, propagating through interpolate_exp
    // math to NaN at the renderer.
    const base = typeof rawBase === 'number' && Number.isFinite(rawBase) && rawBase !== 1 ? rawBase : 1
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
  // v8 strict tooling can wrap the curve spec itself as
  // `["literal", ["exponential", 2]]`. Pre-fix the wrapped form left
  // curveSpec[0] === 'literal' (not 'exponential'/'cubic-bezier'),
  // the curve recognition fell through, and the authored exponential
  // / bezier curve collapsed to linear without a warning.
  let curveSpec: unknown = v[1]
  while (Array.isArray(curveSpec) && curveSpec.length === 2 && curveSpec[0] === 'literal'
      && Array.isArray(curveSpec[1])) {
    curveSpec = curveSpec[1]
  }
  // Element 2 must be the `zoom` accessor.
  const input = v[2]
  if (!Array.isArray(input) || input[0] !== 'zoom') return null
  const stops: Array<{ zoom: number; value: unknown }> = []
  for (let i = 3; i + 1 < v.length; i += 2) {
    // Unwrap v8 strict `["literal", N]` on the zoom key — mirror of
    // the same unwrap applied to each stop value below. Pre-fix a
    // wrapped zoom key failed the typeof === 'number' gate and the
    // entire interpolate-zoom returned null → property fell to its
    // default (e.g. line-width snapping to 1px regardless of zoom).
    const z = unwrapStopLiteral(v[i])
    // Number.isFinite — mirror of the legacy-stops NaN guard above.
    if (typeof z !== 'number' || !Number.isFinite(z)) return null
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
    if (curveSpec[0] === 'exponential') {
      // v8 strict tooling can wrap the base scalar as
      // `["exponential", ["literal", 2]]`. Mirror of the same unwrap
      // in expressions.ts's interpolate handler. Without it the
      // typeof === 'number' gate failed and the exponential curve
      // silently fell back to linear interpolation.
      let b: unknown = curveSpec[1]
      while (Array.isArray(b) && b.length === 2 && b[0] === 'literal') b = b[1]
      // base === 1 is mathematically identical to linear; collapse so
      // the runtime takes the cheaper code path.
      if (typeof b === 'number' && Number.isFinite(b) && b !== 1) {
        // Mirror of the legacy-stops base NaN guard above.
        curve = 'exponential'
        base = b
      }
    } else if (curveSpec[0] === 'cubic-bezier') {
      // CSS cubic-bezier easing approximated by dense piecewise-linear
      // resampling at compile time. For each adjacent stop pair we
      // insert SAMPLES_PER_SEGMENT intermediate stops with eased Y
      // values — the runtime then does its normal linear interpolate
      // between the dense stops and visually approximates the bezier.
      // This only works when stop values are numeric; colour / array
      // values still warn-and-fold-to-linear (see else branch).
      const x1 = typeof curveSpec[1] === 'number' && Number.isFinite(curveSpec[1]) ? curveSpec[1] : 0
      const y1 = typeof curveSpec[2] === 'number' && Number.isFinite(curveSpec[2]) ? curveSpec[2] : 0
      const x2 = typeof curveSpec[3] === 'number' && Number.isFinite(curveSpec[3]) ? curveSpec[3] : 1
      const y2 = typeof curveSpec[4] === 'number' && Number.isFinite(curveSpec[4]) ? curveSpec[4] : 1
      const allNumeric = stops.every(s => typeof s.value === 'number' && Number.isFinite(s.value as number))
      if (allNumeric) {
        const SAMPLES_PER_SEGMENT = 6
        const dense: typeof stops = []
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i]!
          const b = stops[i + 1]!
          dense.push(a)
          const az = a.zoom, bz = b.zoom
          const av = a.value as number
          const bv = b.value as number
          for (let k = 1; k < SAMPLES_PER_SEGMENT; k++) {
            const t = k / SAMPLES_PER_SEGMENT
            const eased = cssBezierEase(t, x1, y1, x2, y2)
            dense.push({
              zoom: az + (bz - az) * t,
              value: av + (bv - av) * eased,
            })
          }
        }
        dense.push(stops[stops.length - 1]!)
        warnings?.push(`["interpolate", ["cubic-bezier", ${x1}, ${y1}, ${x2}, ${y2}], ["zoom"], …] approximated via dense piecewise-linear samples (${SAMPLES_PER_SEGMENT} per segment) — xgis has no per-stop bezier interpolator at runtime.`)
        return { curve, base, stops: dense }
      }
      warnings?.push(`["interpolate", ["cubic-bezier", …], ["zoom"], …] folded to linear — xgis has no per-stop bezier interpolator and non-numeric stop values can't be densified at compile time.`)
    }
  }
  return { curve, base, stops }
}

/** CSS cubic-bezier easing function: given a normalized parameter
 *  t ∈ [0, 1] along the input axis and control points (x1, y1) +
 *  (x2, y2), returns the eased y value. The CSS spec defines the
 *  curve parametrically — both x and y are cubic Bezier polynomials
 *  in a parameter s ∈ [0, 1]. We invert numerically: find s such
 *  that x(s) == t, then evaluate y(s).
 *
 *  Newton-Raphson with 8 iterations converges within ~1e-7 for the
 *  standard CSS control points (x1/x2 ∈ [0, 1]) — well below the
 *  visible discretization of the runtime interpolate. Fallback to
 *  bisection if the derivative goes near-zero (rare with valid CSS
 *  control points but covered for robustness). */
export function cssBezierEase(
  t: number, x1: number, y1: number, x2: number, y2: number,
): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  // x(s) = 3(1-s)² s x1 + 3(1-s) s² x2 + s³
  //      = ((1-3x2+3x1) s + (3x2 - 6x1)) s² + 3x1 s   [Horner-ish]
  // Coefficients of a polynomial a s³ + b s² + c s for the x curve:
  const ax = 1 - 3 * x2 + 3 * x1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 1 - 3 * y2 + 3 * y1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1
  const xOf = (s: number) => ((ax * s + bx) * s + cx) * s
  const dxOf = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  const yOf = (s: number) => ((ay * s + by) * s + cy) * s
  // Newton-Raphson seed at s = t (good approximation when x1/x2
  // close to the diagonal); 8 iterations is plenty for CSS curves.
  let s = t
  for (let i = 0; i < 8; i++) {
    const xs = xOf(s) - t
    if (Math.abs(xs) < 1e-7) return yOf(s)
    const ds = dxOf(s)
    if (Math.abs(ds) < 1e-6) break
    s = s - xs / ds
    if (s < 0) s = 0
    if (s > 1) s = 1
  }
  // Bisection fallback if Newton stalled — guaranteed convergence
  // on a monotonic x(s) (CSS constrains control points so x is
  // monotonic on [0, 1]).
  let lo = 0, hi = 1
  for (let i = 0; i < 24; i++) {
    s = (lo + hi) * 0.5
    const xs = xOf(s)
    if (xs < t) lo = s
    else hi = s
    if (hi - lo < 1e-7) break
  }
  return yOf(s)
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
  // Treat null the same as undefined — Mapbox spec: a null paint
  // value falls back to the property default. Without this gate
  // null flowed through to exprToXgis (commit a969be5 made null
  // lower to the `null` identifier), emitted `fill-[null]`, and the
  // runtime resolved to no-fill instead of the spec default.
  if (isOmitted(v)) return
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
  if (isOmitted(v)) return
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
  // Loop unwrap mirrors colorToXgis (921d5ad) so double-wrapped
  // `["literal", ["literal", 1.5]]` peels in one pass.
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  return v
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

/** Mapbox `paint.fill-translate: [dx, dy]` → xgis
 *  `fill-translate-x-N fill-translate-y-M` (signed pixel offsets).
 *  Constant form only at the moment; zoom-interp on vec2 needs
 *  per-axis decomposition (Mapbox emits a single stop value per
 *  zoom that is itself [x, y]) which the binding-form parser
 *  doesn't yet handle. Default [0,0] is silent.
 *
 *  Sign convention: Mapbox positive x = right, positive y = down
 *  (screen space). The runtime WGSL multiplies by clip.w to keep
 *  the offset constant in pixels regardless of depth, then negates
 *  y for NDC convention (NDC y is UP).
 *
 *  Anchor: fill-translate-anchor: viewport (default) is the only
 *  currently-honored mode. "map" would shift in world coords; not
 *  yet implemented (no OFM hits use map anchor). */
function addFillTranslate(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  // Mapbox v8 wraps `[dx, dy]` as `["literal", [dx, dy]]`. Unwrap so
  // the bare-array fast path catches both forms.
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  if (Array.isArray(v) && v.length === 2
      && typeof v[0] === 'number' && Number.isFinite(v[0])
      && typeof v[1] === 'number' && Number.isFinite(v[1])) {
    // Negative numbers wrap in brackets so the utility-name lexer
    // doesn't read the `-` as a segment separator (same convention
    // as label-offset-x / -y in layers.ts:656).
    const fmt = (n: number): string => n < 0 ? `[${n}]` : `${n}`
    if (v[0] !== 0) out.push(`fill-translate-x-${fmt(v[0])}`)
    if (v[1] !== 0) out.push(`fill-translate-y-${fmt(v[1])}`)
    return
  }
  // Zoom-interp on vec2 — Mapbox emits stops whose values are
  // [x, y] arrays. Full per-axis decomposition + per-frame zoom
  // resolve is the right path (binding-form handler for
  // fill-translate-x/y zoom interp); deferred. Approximate by
  // resolving to the LAST stop's [dx, dy] — works correctly at
  // the highest authored zoom and degrades gracefully at lower
  // zooms where the layer is typically faded (OFM building-top
  // pairs fill-translate with a 13→0, 16→1 fill-opacity ramp so
  // the offset mismatch at mid-zoom hides under near-transparent
  // fills). Same pragmatic pattern as iter 488's text-opacity
  // last-stop approximation.
  if (Array.isArray(v) && v.length >= 4 && v[0] === 'interpolate') {
    // Mapbox interpolate shape: ["interpolate", curve, ["zoom"],
    // z1, val1, z2, val2, ...]. Walk pairs from index 3 → end,
    // take the LAST stop value.
    let last: unknown = null
    for (let i = 3; i + 1 < v.length; i += 2) {
      last = v[i + 1]
    }
    // Unwrap v8 literal-wrap on the inner stop value.
    while (Array.isArray(last) && last.length === 2 && last[0] === 'literal') {
      last = last[1]
    }
    if (Array.isArray(last) && last.length === 2
        && typeof last[0] === 'number' && Number.isFinite(last[0])
        && typeof last[1] === 'number' && Number.isFinite(last[1])) {
      const fmt = (n: number): string => n < 0 ? `[${n}]` : `${n}`
      if (last[0] !== 0) out.push(`fill-translate-x-${fmt(last[0])}`)
      if (last[1] !== 0) out.push(`fill-translate-y-${fmt(last[1])}`)
      return
    }
  }
  warnings.push(`paint.fill-translate: non-constant form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`)
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
  // `["interpolate", curve, ["zoom"], z1, [a,b], …]` is the canonical
  // zoom-interp dasharray shape; the IR currently has no binding-form
  // arm for it (mirror of stroke-offset / line-blur). Drop with a
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

function addOpacity(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  // See unwrapLiteralNumeric — covers `["literal", 0.5]` so the
  // scalar-scale conversion fires. Sibling to colorToXgis literal
  // unwrap (e3c5c62).
  v = unwrapLiteralNumeric(v)
  if (typeof v === 'number') {
    // Reject NaN/Infinity. typeof v === 'number' passes for NaN, then
    // Math.max(0, Math.min(1, NaN)) propagates NaN, `Math.round(NaN
    // * 100)` is NaN, and the emitted utility name is `opacity-NaN`
    // — the runtime lex-rejects it and the whole layer's paint
    // utilities silently drop. Same pattern as the raster-opacity
    // NaN guard.
    if (!Number.isFinite(v)) return
    // Mapbox spec: opacity ∈ [0, 1]. Clamp at convert time so a
    // typo'd negative or > 1 value doesn't produce a malformed
    // utility name (`opacity--50` lexes as an utility name with
    // double-dash that the parser splits on the wrong segment).
    const clamped = Math.max(0, Math.min(1, v <= 1 ? v : v / 100))
    out.push(`opacity-${Math.round(clamped * 100)}`)
    return
  }
  const interp = interpolateZoomCall(v, warnings, (val) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return null
    // Mapbox opacity is 0..1; xgis opacity utility takes 0..100.
    // Scale here so the stops match the utility's scale. Apply the
    // SAME [0, 1] clamp the constant path uses — pre-fix a negative
    // or > 1 stop emitted invalid utility names (opacity-[-50, …])
    // or > 100 percent values. Mirror of the constant-path clamp
    // at line 558. Reject non-finite (NaN/Infinity) too — same
    // class as the constant-path guard above.
    const clamped = Math.max(0, Math.min(1, val <= 1 ? val : val / 100))
    return String(Math.round(clamped * 100))
  })
  if (interp !== null) {
    out.push(`opacity-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) out.push(`opacity-${maybeBracket(x)}`)
}

function addExtrudeHeight(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  v = unwrapLiteralNumeric(v)
  // Mapbox spec: fill-extrusion-height >= 0. Clamp constant
  // literals so a typo'd negative doesn't emit
  // `fill-extrusion-height--5` (double-dash utility name).
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Number.isFinite rejects NaN/Infinity — Math.max(0, NaN) = NaN
    // would emit `fill-extrusion-height-NaN`.
    out.push(`fill-extrusion-height-${Math.max(0, v)}`)
    return
  }
  const interp = interpolateZoomCall(v, warnings, (val, w) => {
    // Mirror of the constant-path clamp: fill-extrusion-height >= 0.
    // Pre-fix a negative numeric stop landed verbatim into the
    // interpolate() emission and the runtime walled below z=0.
    if (typeof val === 'number' && Number.isFinite(val)) return String(Math.max(0, val))
    return exprToXgis(val, w)
  })
  if (interp !== null) {
    out.push(`fill-extrusion-height-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) out.push(`fill-extrusion-height-${maybeBracket(x)}`)
}

function addExtrudeBase(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  v = unwrapLiteralNumeric(v)
  // Mapbox spec: fill-extrusion-base >= 0. Mirror of the
  // addExtrudeHeight clamp.
  if (typeof v === 'number' && Number.isFinite(v)) {
    out.push(`fill-extrusion-base-${Math.max(0, v)}`)
    return
  }
  const interp = interpolateZoomCall(v, warnings, (val, w) => {
    // Mirror of the constant-path clamp: fill-extrusion-base >= 0.
    if (typeof val === 'number' && Number.isFinite(val)) return String(Math.max(0, val))
    return exprToXgis(val, w)
  })
  if (interp !== null) {
    out.push(`fill-extrusion-base-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) out.push(`fill-extrusion-base-${maybeBracket(x)}`)
}
