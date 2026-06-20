// Mapbox `fill-extrusion` layer paint → xgis utilities. Per-type
// emitter group extracted from paint.ts; called by the thin dispatcher
// in paint.ts in the exact same order. Shared emitters (addFill /
// addOpacity / addFillTranslate / surfaceIgnoredPaint) live in
// paint-helpers.
import type { MapboxLayer } from './types'
import { exprToXgis } from './expressions'
import { maybeBracket } from './utils'
import {
  isOmitted,
  unwrapLiteralNumeric,
  interpolateZoomCall,
  addFill,
  addOpacity,
  addFillTranslate,
  addTranslateAnchor,
  surfaceIgnoredPaint,
} from './paint-helpers'

export function emitFillExtrusionPaint(
  out: string[],
  layer: MapboxLayer,
  p: Record<string, unknown>,
  warnings: string[],
): void {
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
  // fill-extrusion-vertical-gradient: the spec default (true) is
  // honoured byte-identically (the extrude vertex shader applies the
  // 0.7→1.0 wall ramp). Only the explicit `false` opt-out changes
  // anything — emit a single `fill-extrusion-vertical-gradient-false`
  // flag the runtime threads to the extrude vertex shader to skip the
  // gradient ramp (flat wall shading). Either way it's no longer an
  // "ignored property", so it's dropped from surfaceIgnoredPaint.
  const vgRaw = p['fill-extrusion-vertical-gradient']
  const vg = Array.isArray(vgRaw) && vgRaw.length === 2 && vgRaw[0] === 'literal' ? vgRaw[1] : vgRaw
  if (vg === false) {
    out.push('fill-extrusion-vertical-gradient-false')
  }
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
  // fill-extrusion-translate-anchor: fill-extrusion-translate rides the
  // SAME `fill-translate-{x,y}` utilities + slot 46/47 uniform as fill
  // (the extrude vertex shaders apply u.fill_translate_x/y), so the
  // anchor=map flag uses the 'fill' prefix and the VTR bearing-rotation
  // applies to the extrude path for free. viewport (default) = byte-
  // identical screen-space.
  addTranslateAnchor(out, 'fill', p['fill-extrusion-translate-anchor'], p['fill-extrusion-translate'], warnings)
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
  // fill-extrusion-vertical-gradient is now implemented (true default
  // honoured + false opt-out emitted above), so it's no longer an
  // ignored property and is omitted from the candidates list.
  surfaceIgnoredPaint(layer.id, p, warnings, [
    'fill-extrusion-ambient-occlusion-intensity',
    'fill-extrusion-ambient-occlusion-radius',
  ])
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
