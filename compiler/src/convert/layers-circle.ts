// ═══ Mapbox circle layer → xgis conversion ═══
// convertCircleLayer relocated verbatim from layers.ts to keep that
// god-file under its shrink-only ratchet ceiling. Zero logic change.

import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { filterToXgis, exprToXgis } from './expressions'
import { interpolateZoomCall } from './paint'
import { colorToXgis } from './colors'
import {
  unwrapLiteralScalar,
  safePropsBag,
  isOmittedValue,
} from './layers-helpers'

/** Mapbox `circle` layer (Point/MultiPoint features rendered as
 *  SDF disks). The X-GIS runtime's PointRenderer is the natural
 *  destination — its default shape IS a circle, and it supports
 *  fill, stroke, opacity, and per-feature data-driven sizing.
 *
 *  Property mapping (paint):
 *    circle-radius        → `size-N`        (both interpret as RADIUS in CSS px;
 *                                            PointRenderer's `radius_px` reads
 *                                            the size attribute directly. Default 5
 *                                            per Mapbox spec, emitted when absent.)
 *    circle-color         → `fill-<color>`
 *    circle-opacity       → `opacity-N`     (Mapbox 0..1 → xgis 0..100, same
 *                                            scale-conversion `addOpacity` does)
 *    circle-stroke-color  → `stroke-<color>`
 *    circle-stroke-width  → `stroke-N`      (CSS px, single edge width)
 *
 *  circle-stroke-opacity → constant folds into stroke hex alpha;
 *  zoom-interp emits `stroke-opacity-[…]` resolved per frame.
 *
 *  Not yet honoured (warnings emitted): circle-translate-anchor,
 *  circle-pitch-scale, circle-pitch-alignment, data-driven
 *  circle-stroke-opacity.
 */
export function convertCircleLayer(layer: MapboxLayer, warnings: string[]): string {
  const paint = safePropsBag((layer as { paint?: unknown }).paint)
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: ${JSON.stringify(layer['source-layer'])}`)
  if (typeof layer.minzoom === 'number' && Number.isFinite(layer.minzoom)) lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number' && Number.isFinite(layer.maxzoom)) lines.push(`  maxzoom: ${layer.maxzoom}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }
  // `layout.visibility: 'none'` applies to circle layers per spec.
  // Same gap as convertSymbolLayer — without this a hidden circle
  // layer kept rendering. Mirror the v8 literal-wrap unwrap.
  const circleVisibility = unwrapLiteralScalar(layout['visibility'])
  if (circleVisibility === 'none') {
    lines.push(`  visible: false`)
  } else if (typeof circleVisibility === 'string' && circleVisibility !== 'visible') {
    // Same enum validation as symbol layer — typo'd visibility value
    // silently treated as default 'visible'.
    warnings.push(`Circle layer "${layer.id}" — visibility "${circleVisibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`)
  }

  const utils: string[] = []

  // circle-radius → size. Constant + interpolate-by-zoom + per-feature
  // expression all supported. Default 5 px per Mapbox spec — emit
  // explicitly so the runtime doesn't fall back to its own default (8).
  const radius = unwrapLiteralScalar(paint['circle-radius'])
  if (typeof radius === 'number' && Number.isFinite(radius)) {
    // Mapbox spec: circle-radius >= 0. Clamp at convert time;
    // Number.isFinite rejects NaN / Infinity (see paint NaN fix).
    // same class as the other paint-numeric clamps. `size--5`
    // would lex as double-dash and crash the layer.
    if (radius < 0) {
      warnings.push(`Circle layer "${layer.id}" — circle-radius ${radius} is negative; Mapbox spec requires >= 0. Clamped to 0 (circles won't render).`)
    }
    utils.push(`size-${Math.max(0, radius)}`)
  } else if (radius !== undefined && radius !== null) {
    const interp = interpolateZoomCall(radius, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
    if (interp !== null) {
      utils.push(`size-[${interp}]`)
    } else {
      const expr = exprToXgis(radius, warnings)
      if (expr !== null) utils.push(`size-[${expr}]`)
      else utils.push('size-5')
    }
  } else {
    utils.push('size-5')
  }

  // circle-color → fill. Routes through the shared color emitters
  // (constant + interpolate-by-zoom + data-driven case/match).
  // Default Mapbox circle-color is #000. Treat `null` the same as
  // `undefined` (omit) — Mapbox spec: a null paint value falls back
  // to the property default. Pre-fix `null` flowed through the
  // emission path, lowered to a bracket-binding with the `null`
  // identifier, and the runtime resolved it to no-fill instead of
  // the spec default #000.
  const fillColor = paint['circle-color']
  if (!isOmittedValue(fillColor)) {
    const interp = interpolateZoomCall(fillColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`fill-[${interp}]`)
    } else {
      const c = colorToXgis(fillColor, warnings)
      if (c) utils.push(`fill-${c}`)
      else {
        const expr = exprToXgis(fillColor, warnings)
        if (expr !== null) utils.push(`fill-[${expr}]`)
        else utils.push('fill-#000')
      }
    }
  } else {
    utils.push('fill-#000')
  }

  // circle-opacity → opacity. Mapbox 0..1 → xgis 0..100 conversion
  // handled inside addOpacity helper; reuse it here. Same null-as-
  // omit treatment as the other paint properties.
  const opacity = unwrapLiteralScalar(paint['circle-opacity'])
  if (opacity !== undefined && opacity !== null) {
    // addOpacity pushes onto its `out` array; we splice into utils.
    const tmp: string[] = []
    // Lazy local re-route to addOpacity from paint.ts. We already have
    // the right helper imported indirectly through paintToUtilities;
    // but since circle isn't routed through paintToUtilities, inline
    // the same logic to keep import surface tight.
    if (typeof opacity === 'number' && Number.isFinite(opacity)) {
      // Mapbox spec: opacity ∈ [0, 1]. Clamp at convert time;
      // same class as the addOpacity clamp (dc0e32a).
      // Number.isFinite rejects NaN/Infinity (see paint NaN fix).
      const clamped = Math.max(0, Math.min(1, opacity <= 1 ? opacity : opacity / 100))
      tmp.push(`opacity-${Math.round(clamped * 100)}`)
    } else {
      const interp = interpolateZoomCall(opacity, warnings, (val) => {
        if (typeof val !== 'number') return null
        const clamped = Math.max(0, Math.min(1, val <= 1 ? val : val / 100))
        return String(Math.round(clamped * 100))
      })
      if (interp !== null) {
        tmp.push(`opacity-[${interp}]`)
      } else {
        // Per-feature case/match opacity. Mirror the line-opacity path
        // in paint.ts:addOpacity — drop the binding into the bracket
        // form so the runtime PropertyShape resolver gets the full AST.
        const expr = exprToXgis(opacity, warnings)
        if (expr !== null) tmp.push(`opacity-[${expr}]`)
      }
    }
    utils.push(...tmp)
  }

  // circle-stroke-color → stroke. Constant + zoom-interp + per-feature
  // case/match — full set, mirroring circle-color above and the line
  // layer's line-color path. Without the data-driven fallback a
  // standalone `["match", ["get","class"], …]` stroke colour silently
  // dropped (same regression class as the line-color fix).
  // Same null-as-omit treatment as circle-color above.
  //
  // circle-stroke-opacity (Mapbox spec). Constant form folds into the
  // stroke-colour hex alpha (no per-frame uniform needed). The
  // zoom-interp form (WS-1, part 4) emits a `stroke-opacity-[interpolate(
  // zoom, …)]` bracket binding the runtime resolves per frame — it
  // multiplies into the circle's baked stroke alpha (feat_data slot 8)
  // in PointRenderer.updateDynamicSizes, mirroring circle-opacity above.
  // In the zoom-interp case the stroke colour is left at its base alpha
  // (no fold) so the per-frame multiply isn't double-applied.
  const strokeColor = paint['circle-stroke-color']
  const strokeOpacityRaw = unwrapLiteralScalar(paint['circle-stroke-opacity'])
  const strokeOpacityConst =
    typeof strokeOpacityRaw === 'number' && Number.isFinite(strokeOpacityRaw)
      ? Math.max(0, Math.min(1, strokeOpacityRaw))
      : null
  // Zoom-interp stroke-opacity → bracket binding (0..100 scale, same as
  // circle-opacity). Only attempt when the raw value is a non-constant
  // object (interpolate call); a bare number stays on the constant fold
  // path. When this is non-null the constant fold is skipped below.
  const strokeOpacityInterp =
    strokeOpacityConst === null
      && typeof strokeOpacityRaw === 'object' && strokeOpacityRaw !== null
      ? interpolateZoomCall(paint['circle-stroke-opacity'], warnings, (val) => {
          if (typeof val !== 'number') return null
          const c = Math.max(0, Math.min(1, val))
          return String(Math.round(c * 100))
        })
      : null
  if (strokeOpacityInterp !== null) utils.push(`stroke-opacity-[${strokeOpacityInterp}]`)
  if (!isOmittedValue(strokeColor)) {
    const interp = interpolateZoomCall(strokeColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`stroke-[${interp}]`)
    } else {
      const c = colorToXgis(strokeColor, warnings)
      if (c) {
        // Fold constant stroke-opacity into the hex alpha channel
        // when present. resolveColor already supports the 8-char
        // hex form with alpha; convert opacity to a u8 alpha and
        // append. Skip when no opacity declared (1.0 default ==
        // 6-char hex stays).
        if (strokeOpacityConst !== null && strokeOpacityConst < 0.999) {
          // c is `#rrggbb` or `#rrggbbaa`. Replace alpha byte.
          const baseAlpha = c.length === 9
            ? parseInt(c.slice(7, 9), 16) / 255
            : 1
          const a = Math.round(baseAlpha * strokeOpacityConst * 255)
          const aHex = a.toString(16).padStart(2, '0')
          const rgb = c.slice(0, 7) // `#rrggbb`
          utils.push(`stroke-${rgb}${aHex}`)
        } else {
          utils.push(`stroke-${c}`)
        }
      } else {
        const expr = exprToXgis(strokeColor, warnings)
        if (expr !== null) utils.push(`stroke-[${expr}]`)
      }
    }
  }

  // circle-stroke-width → stroke-N. Edge width in CSS px.
  // Spec: circle-stroke-width >= 0. Constant arm has a `> 0` gate
  // that already drops negatives; the interp-zoom callback clamps
  // per-stop to avoid double-dash utility names.
  const strokeWidth = unwrapLiteralScalar(paint['circle-stroke-width'])
  if (typeof strokeWidth === 'number' && Number.isFinite(strokeWidth)) {
    // Emit the width EXPLICITLY even for 0 / negative (clamped to 0).
    // The interpreter seeds a shared `strokeWidth = 1` default (that is the
    // line-width spec default, NOT the circle one), so an omitted / zero
    // circle-stroke-width must override it to 0 or the circle draws a
    // spurious 1 px edge. Number.isFinite rejects NaN / Infinity.
    if (strokeWidth < 0) {
      warnings.push(`Circle layer "${layer.id}" — circle-stroke-width ${strokeWidth} is negative; Mapbox spec requires >= 0. Clamped to 0 (no stroke).`)
    }
    utils.push(`stroke-${Math.max(0, strokeWidth)}`)
  } else if (strokeWidth !== undefined && strokeWidth !== null) {
    const interp = interpolateZoomCall(strokeWidth, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
    if (interp !== null) {
      utils.push(`stroke-[${interp}]`)
    } else {
      // Per-feature numeric expression (`case` / `match` / etc.) —
      // route through the bracket form the same way circle-radius does.
      // Without this branch a per-feature stroke-width silently dropped
      // and the circle's edge collapsed to zero.
      const expr = exprToXgis(strokeWidth, warnings)
      if (expr !== null) utils.push(`stroke-[${expr}]`)
    }
  } else {
    // OMITTED — Mapbox spec default circle-stroke-width = 0 (no stroke).
    // Emit stroke-0 so the circle does not inherit the interpreter's shared
    // strokeWidth = 1 (the line-width default). Matches MapLibre, which
    // draws NO circle edge unless circle-stroke-width is authored > 0.
    utils.push('stroke-0')
  }

  // circle-translate → circle-translate-x-N circle-translate-y-M.
  // Constant [dx, dy] folds to scalar utilities; zoom-interp on the vec2
  // splits per-axis into circle-translate-{x,y}-[interpolate(zoom,…)]
  // bracket bindings resolved per frame (WS-1 part 5, mirrors
  // addFillTranslate in paint.ts). Default [0,0] → silent.
  const circleTranslate = paint['circle-translate']
  if (circleTranslate !== undefined && circleTranslate !== null) {
    let tv: unknown = circleTranslate
    // Unwrap Mapbox v8 ["literal", [dx, dy]] form.
    while (Array.isArray(tv) && tv.length === 2 && tv[0] === 'literal') tv = tv[1]
    if (Array.isArray(tv) && tv.length === 2
        && typeof tv[0] === 'number' && Number.isFinite(tv[0])
        && typeof tv[1] === 'number' && Number.isFinite(tv[1])) {
      // Negative numbers wrap in brackets so the utility lexer doesn't
      // treat the `-` as a segment separator — same convention as
      // fill-translate-x / label-offset in lower.ts.
      const fmt = (n: number): string => n < 0 ? `[${n}]` : `${n}`
      if (tv[0] !== 0) utils.push(`circle-translate-x-${fmt(tv[0] as number)}`)
      if (tv[1] !== 0) utils.push(`circle-translate-y-${fmt(tv[1] as number)}`)
    } else if (Array.isArray(tv) && tv.length >= 4 && tv[0] === 'interpolate') {
      // WS-1 (part 5) — per-frame zoom-interp on the vec2, mirroring
      // addFillTranslate in paint.ts. Split into scalar x and y
      // zoom-interpolates and emit `circle-translate-x-[…]` +
      // `circle-translate-y-[…]` bracket bindings. lower.ts parses each
      // into RenderNode.circleTranslate{X,Y}Shape → emit threads them to
      // ShowCommand → PointRenderer.updateDynamicSizes resolves per frame
      // into the point frame uniform (circle_params.xy). Replaces the old
      // last-stop approximation.
      const axisInterp = (idx: 0 | 1): string | null =>
        interpolateZoomCall(tv, warnings, (val) => {
          let inner: unknown = val
          while (Array.isArray(inner) && inner.length === 2 && inner[0] === 'literal') inner = inner[1]
          if (Array.isArray(inner) && inner.length === 2
              && typeof inner[idx] === 'number' && Number.isFinite(inner[idx])) {
            return String(inner[idx])
          }
          return null
        })
      const ix = axisInterp(0)
      const iy = axisInterp(1)
      if (ix !== null && iy !== null) {
        utils.push(`circle-translate-x-[${ix}]`)
        utils.push(`circle-translate-y-[${iy}]`)
      } else {
        warnings.push(`Layer "${layer.id}" — circle-translate: non-constant form not yet supported — value dropped.`)
      }
    } else {
      warnings.push(`Layer "${layer.id}" — circle-translate: non-constant form not yet supported — value dropped.`)
    }
  }

  // circle-blur → circle-blur-N. Soft edge feathering in CSS px.
  // Extends the point fragment's existing smoothstep AA band.
  // Default 0 → no-op / silent.
  const circleBlurVal = unwrapLiteralScalar(paint['circle-blur'])
  if (typeof circleBlurVal === 'number' && Number.isFinite(circleBlurVal)) {
    if (circleBlurVal < 0) {
      warnings.push(`Circle layer "${layer.id}" — circle-blur ${circleBlurVal} is negative; Mapbox spec requires >= 0. Clamped to 0.`)
    }
    if (circleBlurVal > 0) utils.push(`circle-blur-${Math.max(0, circleBlurVal)}`)
  } else if (paint['circle-blur'] !== undefined && paint['circle-blur'] !== null && circleBlurVal === undefined) {
    // Non-scalar (expression / zoom-interp) — not yet supported. Warn + drop.
    warnings.push(`Layer "${layer.id}" — circle-blur: non-constant form not yet supported — value dropped.`)
  }

  // Surface dropped properties so the user knows the gap.
  const ignored: string[] = []
  for (const k of [
    'circle-translate-anchor',
    'circle-pitch-scale', 'circle-pitch-alignment',
    // circle-stroke-opacity: the constant form folds into stroke hex
    // alpha and the zoom-interp form emits a `stroke-opacity-[…]`
    // binding (both handled above). Only a non-interpolate data-driven
    // form remains a gap — surface it so the user sees it. Check the
    // unwrapped value shape: a scalar number OR a resolved zoom-interp
    // (strokeOpacityInterp !== null) we handled; otherwise warn.
    ...(typeof strokeOpacityRaw === 'object' && strokeOpacityRaw !== null
      && strokeOpacityInterp === null
      ? ['circle-stroke-opacity']
      : []),
    'circle-sort-key',
  ]) {
    // Treat null the same as undefined — see the symbol-ignored
    // gate above for the rationale.
    const pv = paint[k]
    if (pv === undefined || pv === null) continue
    // Special-case circle-translate-anchor: when parent
    // circle-translate is ABSENT, the anchor is a no-op (anchor only
    // changes the translate's coordinate space). Skip the warning
    // in that case — mirror of the surfaceIgnoredPaint ANCHOR_PARENT
    // check for fill / line equivalents.
    if (k === 'circle-translate-anchor'
        && (paint['circle-translate'] === undefined || paint['circle-translate'] === null)) {
      continue
    }
    // circle-translate-anchor='viewport' matches X-GIS behaviour
    // (viewport-space translate); only 'map' is the real gap. Mirror
    // of the SPEC_DEFAULT_NO_WARN suppression in surfaceIgnoredPaint.
    if (k === 'circle-translate-anchor') {
      let av: unknown = pv
      while (Array.isArray(av) && av.length === 2 && av[0] === 'literal') av = av[1]
      if (av === 'viewport') continue
    }
    // circle-pitch-alignment='viewport' (Mapbox spec default) matches
    // X-GIS billboard-rendering default; 'map' (project disc onto
    // ground plane) is the real gap.
    if (k === 'circle-pitch-alignment') {
      let av: unknown = pv
      while (Array.isArray(av) && av.length === 2 && av[0] === 'literal') av = av[1]
      if (av === 'viewport' || av === 'auto') continue
    }
    // circle-pitch-scale='viewport' matches X-GIS (radius stays
    // constant on screen). 'map' (Mapbox spec default — radius
    // scales with zoom in map space) is the real gap.
    if (k === 'circle-pitch-scale') {
      let av: unknown = pv
      while (Array.isArray(av) && av.length === 2 && av[0] === 'literal') av = av[1]
      if (av === 'viewport') continue
    }
    ignored.push(k)
  }
  // Reuse the safePropsBag-guarded `layout` const from the top of
  // this function — a malformed layer with `layout: "..."` (string)
  // or `layout: [..]` (array) would otherwise let the raw read of
  // layer.layout index a char or undefined, and the ignored-prop
  // warning would garbage-output. Treat null the same as undefined
  // per Mapbox spec — null means "property omitted".
  const lsk = layout['circle-sort-key']
  if (lsk !== undefined && lsk !== null) ignored.push('circle-sort-key (layout)')
  if (ignored.length > 0) {
    warnings.push(`Circle layer "${layer.id}" — ignored properties: ${ignored.join(', ')}`)
  }

  lines.push('  | ' + utils.join(' '))
  lines.push('}')
  return lines.join('\n')
}
