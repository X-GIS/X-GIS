// ═══ Mapbox circle layer → xgis conversion ═══
// convertCircleLayer relocated verbatim from layers.ts to keep that
// god-file under its shrink-only ratchet ceiling. Zero logic change.

import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { exprToXgis } from './expressions'
import { interpolateZoomCall } from './paint'
import { colorToXgis } from './colors'
import {
  unwrapLiteralScalar,
  safePropsBag,
  isOmittedValue,
  filterLineOrFailClosed,
  applyAlphaMultiplier,
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
 *  circle-pitch-scale → circle-pitch-scale-map flag (emitted only for
 *  'map'). 'map' scales the circle radius with the map perspective (point
 *  VS divides by clip.w).
 *
 *  circle-pitch-alignment → circle-pitch-alignment-map flag (#2118, emitted
 *  only for 'map'; 'viewport' IS this knob's spec default and emits nothing).
 *  'map' lays the disc in the ground plane — the point VS maps the quad's
 *  local axes through the ground basis, so it foreshortens into an ellipse.
 *
 *  Not yet honoured (warnings emitted): circle-translate-anchor,
 *  data-driven circle-stroke-opacity, and circle-pitch-alignment 'map'
 *  paired with an EXPLICIT circle-pitch-scale 'viewport' (see below).
 */
export function convertCircleLayer(layer: MapboxLayer, warnings: string[]): string {
  const paint = safePropsBag((layer as { paint?: unknown }).paint)
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: ${JSON.stringify(layer['source-layer'])}`)
  if (typeof layer.minzoom === 'number' && Number.isFinite(layer.minzoom))
    lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number' && Number.isFinite(layer.maxzoom))
    lines.push(`  maxzoom: ${layer.maxzoom}`)
  // Authored-but-unconvertible filter fails CLOSED (filter: false →
  // match nothing), not open — see filterLineOrFailClosed.
  const circleFilterLine = filterLineOrFailClosed(layer.filter, warnings)
  if (circleFilterLine !== null) lines.push(circleFilterLine)
  // `layout.visibility: 'none'` applies to circle layers per spec.
  // Same gap as convertSymbolLayer — without this a hidden circle
  // layer kept rendering. Mirror the v8 literal-wrap unwrap.
  const circleVisibility = unwrapLiteralScalar(layout['visibility'])
  if (circleVisibility === 'none') {
    lines.push(`  visible: false`)
  } else if (typeof circleVisibility === 'string' && circleVisibility !== 'visible') {
    // Same enum validation as symbol layer — typo'd visibility value
    // silently treated as default 'visible'.
    warnings.push(
      `Circle layer "${layer.id}" — visibility "${circleVisibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`,
    )
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
      warnings.push(
        `Circle layer "${layer.id}" — circle-radius ${radius} is negative; Mapbox spec requires >= 0. Clamped to 0 (circles won't render).`,
      )
    }
    utils.push(`size-${Math.max(0, radius)}`)
  } else if (radius !== undefined && radius !== null) {
    const interp = interpolateZoomCall(radius, warnings, (val) =>
      typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null,
    )
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
    strokeOpacityConst === null && typeof strokeOpacityRaw === 'object' && strokeOpacityRaw !== null
      ? interpolateZoomCall(paint['circle-stroke-opacity'], warnings, (val) => {
          if (typeof val !== 'number') return null
          const c = Math.max(0, Math.min(1, val))
          return String(Math.round(c * 100))
        })
      : null
  if (strokeOpacityInterp !== null) utils.push(`stroke-opacity-[${strokeOpacityInterp}]`)
  let strokeColorDataDriven = false
  if (!isOmittedValue(strokeColor)) {
    // #2318: fold the constant circle-stroke-opacity into every zoom-
    // interp stroke-colour stop too — pre-fix only the single-hex
    // constant-colour branch below applied it, so a constant stroke-
    // opacity paired with a zoom-interpolated circle-stroke-color was
    // silently dropped (stroke drawn opaque at every zoom).
    const interp = interpolateZoomCall(strokeColor, warnings, (val, w) => {
      const c = colorToXgis(val, w)
      return c === null ? null : applyAlphaMultiplier(c, strokeOpacityConst)
    })
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
          // applyAlphaMultiplier handles #rgb / #rgba / #rrggbb / #rrggbbaa,
          // expanding short-form hex before folding the opacity into the alpha
          // channel. Pre-fix this site assumed c was always #rrggbb (7 chars)
          // or #rrggbbaa (9 chars): for "#abc" it emitted "#abc80" (5 digits)
          // which the runtime hex regex rejected → stroke silently dropped.
          utils.push(`stroke-${applyAlphaMultiplier(c, strokeOpacityConst)}`)
        } else {
          utils.push(`stroke-${c}`)
        }
      } else {
        const expr = exprToXgis(strokeColor, warnings)
        if (expr !== null) {
          utils.push(`stroke-[${expr}]`)
          strokeColorDataDriven = true
        }
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
      warnings.push(
        `Circle layer "${layer.id}" — circle-stroke-width ${strokeWidth} is negative; Mapbox spec requires >= 0. Clamped to 0 (no stroke).`,
      )
    }
    utils.push(`stroke-${Math.max(0, strokeWidth)}`)
  } else if (strokeWidth !== undefined && strokeWidth !== null) {
    const interp = interpolateZoomCall(strokeWidth, warnings, (val) =>
      typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null,
    )
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
    if (
      Array.isArray(tv) &&
      tv.length === 2 &&
      typeof tv[0] === 'number' &&
      Number.isFinite(tv[0]) &&
      typeof tv[1] === 'number' &&
      Number.isFinite(tv[1])
    ) {
      // Negative numbers wrap in brackets so the utility lexer doesn't
      // treat the `-` as a segment separator — same convention as
      // fill-translate-x / label-offset in lower.ts.
      const fmt = (n: number): string => (n < 0 ? `[${n}]` : `${n}`)
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
          while (Array.isArray(inner) && inner.length === 2 && inner[0] === 'literal')
            inner = inner[1]
          if (
            Array.isArray(inner) &&
            inner.length === 2 &&
            typeof inner[idx] === 'number' &&
            Number.isFinite(inner[idx])
          ) {
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
        warnings.push(
          `Layer "${layer.id}" — circle-translate: non-constant form not yet supported — value dropped.`,
        )
      }
    } else {
      warnings.push(
        `Layer "${layer.id}" — circle-translate: non-constant form not yet supported — value dropped.`,
      )
    }
  }

  // circle-blur → circle-blur-N. Soft edge feathering in CSS px.
  // Extends the point fragment's existing smoothstep AA band.
  // Default 0 → no-op / silent.
  const circleBlurVal = unwrapLiteralScalar(paint['circle-blur'])
  if (typeof circleBlurVal === 'number' && Number.isFinite(circleBlurVal)) {
    if (circleBlurVal < 0) {
      warnings.push(
        `Circle layer "${layer.id}" — circle-blur ${circleBlurVal} is negative; Mapbox spec requires >= 0. Clamped to 0.`,
      )
    }
    if (circleBlurVal > 0) utils.push(`circle-blur-${Math.max(0, circleBlurVal)}`)
  } else if (
    paint['circle-blur'] !== undefined &&
    paint['circle-blur'] !== null &&
    circleBlurVal === undefined
  ) {
    // Non-scalar (expression / zoom-interp) — not yet supported. Warn + drop.
    warnings.push(
      `Layer "${layer.id}" — circle-blur: non-constant form not yet supported — value dropped.`,
    )
  }

  // circle-pitch-scale → circle-pitch-scale-map flag (emitted ONLY for the
  // 'map' mode). 'map' makes the circle radius scale with the map perspective
  // (circles farther / under pitch shrink) — the point VS multiplies the screen
  // radius by w_ref/clip.w. Mirror of the fill-translate-anchor=map convention.
  //
  // ═══ #2118 AUDIT — THIS KNOB'S DEFAULT IS INVERTED, DELIBERATELY LEFT ═══
  // Mapbox/MapLibre v8 default `circle-pitch-scale` to **"map"**, not
  // "viewport": `paint_circle['circle-pitch-scale'].default === 'map'` in
  // @maplibre/maplibre-gl-style-spec's reference/v8.json (checked against the
  // copy this repo already has in node_modules — not from memory). An ABSENT
  // circle-pitch-scale therefore means "map", so an unauthored circle in a
  // pitched MapLibre map shrinks with distance while X-GIS draws it at a
  // constant screen radius. Resolving the default here is a one-line change
  // (`psv !== 'viewport'` instead of `psv === 'map'`), and it is NOT made: it
  // would alter the rendering of every existing circle layer at pitch > 0, which
  // is a product decision with its own regression rung, not a side effect of
  // adding circle-pitch-alignment. It is left recorded rather than silently
  // carried. Note the sibling below defaults the OTHER way, and that asymmetry
  // is real spec, not an oversight here.
  let psv: unknown = paint['circle-pitch-scale']
  while (Array.isArray(psv) && psv.length === 2 && psv[0] === 'literal') psv = psv[1]
  if (psv === 'map') {
    utils.push('circle-pitch-scale-map')
  } else if (psv !== undefined && psv !== null && psv !== 'viewport') {
    warnings.push(
      `Circle layer "${layer.id}" — circle-pitch-scale "${String(psv).slice(0, 40)}" is not a valid enum; expected 'map' | 'viewport'. Treated as 'viewport'.`,
    )
  }

  // circle-pitch-alignment → circle-pitch-alignment-map flag (#2118). Emitted
  // ONLY for 'map'; 'viewport' IS this knob's spec default (the opposite of the
  // sibling above) and emits nothing, so the untilted and default renderings stay
  // byte-identical. 'map' lays the disc in the ground plane: the point VS maps the
  // quad's local axes through the ground basis (the WGSL image of
  // map/src/text/ground-basis.ts) so the circle foreshortens into an ellipse.
  //
  // WHY 'map' + an EXPLICIT 'viewport' SCALE IS REFUSED RATHER THAN APPROXIMATED.
  // Once the disc lies in the ground plane the basis ALREADY carries the distance
  // foreshortening, so alignment:map + scale:map is the un-compensated pairing and
  // needs nothing extra — and it is also what an author who writes only
  // circle-pitch-alignment:map asks for, since scale defaults to 'map'. Asking for
  // scale:viewport on top means "lie in the ground plane but keep the on-screen
  // size", which MapLibre buys with its perspective_ratio — clamp(0.5 + 0.5 ·
  // distanceRatio, 0, 4), one uniform switched by u_pitch_with_map. That factor has
  // a single authority landing as `groundPerspectiveScale` (#2012 D1 INC-5); it is
  // not on main yet, and writing a second copy of it here is exactly the
  // two-authorities drift ADR-0012 and ground-basis.ts both forbid. So the pair
  // warns and degrades to today's billboard instead of approximating it.
  let pav: unknown = paint['circle-pitch-alignment']
  while (Array.isArray(pav) && pav.length === 2 && pav[0] === 'literal') pav = pav[1]
  if (pav === 'map') {
    if (psv === 'viewport') {
      warnings.push(
        `Circle layer "${layer.id}" — circle-pitch-alignment "map" with an explicit circle-pitch-scale "viewport" is not yet supported: that pair needs MapLibre's perspective_ratio compensation (clamp(0.5 + 0.5 * distanceRatio, 0, 4)), whose single authority (groundPerspectiveScale, #2012 D1 INC-5) is not on main, and a second copy of it here would be a duplicate ground-perspective authority. circle-pitch-alignment dropped — the circle stays viewport-aligned (unchanged rendering). Alternative: omit circle-pitch-scale (it defaults to "map", the supported pairing) or set it to "map" explicitly.`,
      )
    } else {
      utils.push('circle-pitch-alignment-map')
    }
  } else if (pav !== undefined && pav !== null && pav !== 'viewport' && pav !== 'auto') {
    // Kept from the pre-#2118 `ignored` sweep, which surfaced a typo'd value this
    // way: dropping the property from that list must not drop its enum
    // validation with it. 'auto' is tolerated silently exactly as before — it is
    // not in the v8 enum for THIS property, but the converter has always resolved
    // it to the default rather than complaining, and tightening that is a
    // different change from adding the feature.
    warnings.push(
      `Circle layer "${layer.id}" — circle-pitch-alignment "${String(pav).slice(0, 40)}" is not a valid enum; expected 'map' | 'viewport'. Treated as 'viewport'.`,
    )
  }

  // Surface dropped properties so the user knows the gap.
  const ignored: string[] = []
  for (const k of [
    'circle-translate-anchor',
    // circle-stroke-opacity: the constant form folds into stroke hex
    // alpha (constant colour, and #2318, zoom-interp colour) and the
    // zoom-interp form emits a `stroke-opacity-[…]` binding (both
    // handled above). Two shapes remain a gap — surface them so the
    // user sees it: a non-interpolate data-driven opacity, or (#2318)
    // a constant opacity paired with a data-driven stroke-color —
    // there is no per-feature stroke-opacity lane to fold it into.
    ...(typeof strokeOpacityRaw === 'object' &&
    strokeOpacityRaw !== null &&
    strokeOpacityInterp === null
      ? ['circle-stroke-opacity']
      : []),
    ...(strokeColorDataDriven && strokeOpacityConst !== null && strokeOpacityConst < 0.999
      ? ['circle-stroke-opacity']
      : []),
    'circle-sort-key',
  ]) {
    const pv = paint[k]
    // circle-translate-anchor is decided by the SPEC DEFAULT, not by
    // presence (#2170). reference/v8.json gives it default='map', and
    // the point renderer has no map arm — it always applies
    // circle-translate in viewport/NDC space (there is no
    // circle-translate-anchor-map utility, unlike fill / line /
    // fill-extrusion). So an ABSENT anchor means the spec's world-space
    // 'map' and is just as real a gap as an explicit one; only an
    // explicit 'viewport' is honoured. Still a no-op without the parent
    // circle-translate — the anchor only selects the offset's
    // coordinate space.
    if (k === 'circle-translate-anchor') {
      const parent = paint['circle-translate']
      if (parent === undefined || parent === null) continue
      let av: unknown = pv
      while (Array.isArray(av) && av.length === 2 && av[0] === 'literal') av = av[1]
      if (av === 'viewport') continue
      ignored.push(k)
      continue
    }
    // Treat null the same as undefined — see the symbol-ignored
    // gate above for the rationale.
    if (pv === undefined || pv === null) continue
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
