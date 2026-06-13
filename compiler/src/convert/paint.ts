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
import {
  isOmitted,
  unwrapLiteralNumeric,
  unwrapLiteralScalarLocal,
  interpolateZoomCall,
} from './paint-helpers'
// Re-export public helpers so importers of './paint' keep their surface.
export { cssBezierEase, interpolateZoomCall } from './paint-helpers'

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
    // iter-177 — fill-pattern Stage 1: constant string emit. Runtime
    // resolves the sprite at draw time and uses the sprite's centre
    // pixel as the layer fill colour (placeholder for the real UV-
    // tiling fragment shader, which is Stage 2). On OFM Liberty the
    // `landcover_wetland` (wetland_bg_11) and `road_area_pattern`
    // (pedestrian_polygon) layers have NO fill-color authored —
    // they were invisible pre-iter-177. The centre-pixel colour at
    // least gives the layer its intended hue band so the wetland
    // reads as light-blue and the pedestrian polygon reads as tan.
    if (p['fill-pattern'] !== undefined && p['fill-pattern'] !== null) {
      const v = p['fill-pattern']
      if (typeof v === 'string') {
        out.push(`fill-pattern-${v}`)
      } else {
        warnings.push(`Layer "${layer.id}" — fill-pattern non-constant form (expression / interpolate) not yet wired through the IR; the constant string form is supported (iter-177). The layer falls back to fill-color or transparent.`)
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
    // iter-180 — fill-extrusion-translate Stage 1. The fill-extrusion
    // WGSL paths (vs_main_quantized + vs_main_quantized_extruded) already
    // apply u.fill_translate_x/y to clip-space xy at the end of the
    // vertex stage. The runtime Uniforms struct is SHARED across
    // fill + fill-extrusion (one Uniforms binding per pipeline kind),
    // so routing fill-extrusion-translate through the same
    // `fill-translate-x-N` / `fill-translate-y-M` utilities works end-
    // to-end with zero runtime changes — the converter just needs to
    // stop dropping the value.
    addFillTranslate(out, p['fill-extrusion-translate'], warnings)
    // iter-179 — fill-extrusion-pattern Stage 1. Building walls are
    // drawn through the same fill RGBA channel as ground fills (the
    // extrude shader multiplies the colour by wall_shade in the
    // fragment stage), so reusing `fill-pattern-<name>` here gives
    // pattern-only building styles a visible wall colour. Real
    // bitmap wall texturing is Stage 2.
    if (p['fill-extrusion-pattern'] !== undefined && p['fill-extrusion-pattern'] !== null) {
      const v = p['fill-extrusion-pattern']
      if (typeof v === 'string') {
        out.push(`fill-pattern-${v}`)
      } else {
        warnings.push(`Layer "${layer.id}" — fill-extrusion-pattern non-constant form (expression / interpolate) not yet wired through the IR; the constant string form is supported (iter-179). The walls fall back to fill-extrusion-color or transparent.`)
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
    if (!Number.isFinite(v)) {
      warnings.push(`paint.*opacity: non-finite value ${v} (NaN/Infinity); Mapbox spec requires a finite number in [0, 1]. Property dropped.`)
      return
    }
    // Mapbox spec: opacity ∈ [0, 1]. Clamp at convert time so a
    // typo'd negative or > 1 value doesn't produce a malformed
    // utility name (`opacity--50` lexes as an utility name with
    // double-dash that the parser splits on the wrong segment).
    if (v < 0 || v > 100) {
      warnings.push(`paint.*opacity: value ${v} out of range; Mapbox spec requires [0, 1] (X-GIS auto-detects [0, 100] percent). Clamped to ${Math.max(0, Math.min(1, v <= 1 ? v : v / 100))}.`)
    }
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
    if (v < 0) {
      warnings.push(`paint.fill-extrusion-height: value ${v} is negative; Mapbox spec requires >= 0. Clamped to 0 (walls won't extrude).`)
    }
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
    if (v < 0) {
      warnings.push(`paint.fill-extrusion-base: value ${v} is negative; Mapbox spec requires >= 0. Clamped to 0.`)
    }
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
