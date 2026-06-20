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

export function emitFillPaint(
  out: string[],
  layer: MapboxLayer,
  p: Record<string, unknown>,
  warnings: string[],
): void {
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
  // fill-translate-anchor: viewport (default) is screen-space (today's
  // behaviour, byte-identical). map → world-space offset that rotates
  // with the map bearing; emitted as fill-translate-anchor-map.
  addTranslateAnchor(out, 'fill', p['fill-translate-anchor'], p['fill-translate'], warnings)
  // fill-antialias: default `true` matches X-GIS runtime (the fill
  // fragment multiplies in the sphere-rim smoothstep AA fade). Only
  // the explicit `false` opt-out changes anything — emit a single
  // `fill-antialias-false` flag the runtime threads to the fragment
  // shader to drop the rim smoothstep (hard edges, pixel-art intent).
  // Geometric edge AA from pipeline MSAA is not per-layer disable-able
  // and is left untouched; the unauthored / true path is byte-identical.
  const aaRaw = p['fill-antialias']
  const aa = Array.isArray(aaRaw) && aaRaw.length === 2 && aaRaw[0] === 'literal' ? aaRaw[1] : aaRaw
  if (aa === false) {
    out.push('fill-antialias-false')
  }
  surfaceIgnoredPaint(layer.id, p, warnings, [
    'fill-sort-key',
  ])
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
