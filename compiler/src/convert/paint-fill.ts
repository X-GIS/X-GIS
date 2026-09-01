// Mapbox `fill` layer paint → xgis utilities. Per-type emitter group
// extracted from paint.ts; called by the thin dispatcher in paint.ts
// in the exact same order. Shared emitters (addFill / addOpacity /
// addFillTranslate / surfaceIgnoredPaint) live in paint-helpers.
import type { MapboxLayer } from './types'
import { colorToXgis } from './colors'
import { exprToXgis } from './expressions'
import {
  isOmitted,
  interpolateZoomCall,
  addFill,
  addOpacity,
  addFillTranslate,
  addTranslateAnchor,
  surfaceIgnoredPaint,
} from './paint-helpers'
import { boolZoomStepCall } from './bool-zoom-step'

export function emitFillPaint(
  out: string[],
  layer: MapboxLayer,
  p: Record<string, unknown>,
  warnings: string[],
): void {
  addFill(out, p['fill-color'], warnings)
  addOpacity(out, p['fill-opacity'], warnings)
  // #2166 — fill-antialias gates the fill-OUTLINE draw. MapLibre creates its
  // context with `antialias: false` (map.ts:457), so its only fill-edge AA is
  // the 1 px feathered outline pass, and draw_fill.ts:44 draws that pass only
  // when the property is true. The spec says the same:
  // `fill-outline-color.requires = [{"!":"fill-pattern"},{"fill-antialias":true}]`.
  // So the value has to be read BEFORE the stroke emit, not 46 lines after it.
  // Only the CONSTANT `false` is decidable here — the zoom-step form needs a
  // zoom-gated stroke, which is not a convert-time decision.
  const aaRaw = p['fill-antialias']
  const aa = Array.isArray(aaRaw) && aaRaw.length === 2 && aaRaw[0] === 'literal' ? aaRaw[1] : aaRaw
  if (aa !== false) addFillOutline(out, p['fill-outline-color'], warnings)
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
      warnings.push(
        `Layer "${layer.id}" — fill-pattern non-constant form (expression / interpolate) not yet wired through the IR; the constant string form is supported (iter-177). The layer falls back to fill-color or transparent.`,
      )
    }
  }
  addFillTranslate(out, p['fill-translate'], warnings, 'fill-translate')
  // fill-translate-anchor: the v8 default is "map", not viewport (#2170) —
  // an ABSENT anchor emits fill-translate-anchor-map and the offset rotates
  // with the map bearing; only an explicit "viewport" keeps it screen-space.
  // This comment said the opposite, describing the pre-#2170 behaviour.
  addTranslateAnchor(out, 'fill', p['fill-translate-anchor'], p['fill-translate'], warnings)
  // fill-antialias, second half: besides gating the outline emit above,
  // the explicit `false` opt-out emits a single `fill-antialias-false`
  // flag the runtime threads to the fragment shader to drop the rim
  // smoothstep (hard edges, pixel-art intent). The unauthored / true
  // path is byte-identical. `aa` is read once, above the outline emit.
  if (aa === false) {
    out.push('fill-antialias-false')
  } else if (typeof aa === 'object' && aa !== null) {
    // #1995 — the ZOOM form. A boolean is `interpolated: false` in the spec,
    // so a zoom-varying one is spelled `["step", ["zoom"], …]` (OFM Bright
    // landcover-wood). The flag already rides a PER-FRAME uniform lane, so
    // that curve lifts to a 0/1 `step(zoom, …)` binding the runtime resolves
    // each frame into the same lane — no new GPU surface, exact fidelity.
    const aaStep = boolZoomStepCall(aa)
    if (aaStep !== null) {
      out.push(`fill-antialias-[${aaStep}]`)
    } else {
      // Everything else still drops with the loss surfaced: a per-feature
      // (data-driven) input has no per-feature lane, and a non-step zoom
      // form has no boolean curve to lift.
      warnings.push(
        `Layer "${layer.id}" — fill-antialias zoom/data expression not supported (only constant true/false and a boolean zoom step) — dropped.`,
      )
    }
  }
  surfaceIgnoredPaint(layer.id, p, warnings, ['fill-sort-key'])
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
