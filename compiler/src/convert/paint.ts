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

export function paintToUtilities(layer: MapboxLayer, warnings: string[]): string[] {
  const out: string[] = []
  const p = layer.paint ?? {}

  if (layer.type === 'fill') {
    addFill(out, p['fill-color'], warnings)
    addOpacity(out, p['fill-opacity'], warnings)
  } else if (layer.type === 'line') {
    addStroke(out, p['line-color'], warnings)
    addStrokeWidth(out, p['line-width'], warnings)
    addStrokeDash(out, p['line-dasharray'], warnings)
    addOpacity(out, p['line-opacity'], warnings)
  } else if (layer.type === 'fill-extrusion') {
    addFill(out, p['fill-extrusion-color'], warnings)
    addOpacity(out, p['fill-extrusion-opacity'], warnings)
    addExtrudeHeight(out, p['fill-extrusion-height'], warnings)
    addExtrudeBase(out, p['fill-extrusion-base'], warnings)
  }

  return out
}

// ─── interpolate-by-zoom support ─────────────────────────────────────

/** Pull `(zoom, value)` pairs out of an `["interpolate", curve,
 *  ["zoom"], z1, v1, …]` expression. Returns null when the shape
 *  doesn't match (non-zoom input, missing stops, etc.) so callers
 *  can short-circuit and route through the generic expression
 *  converter instead. */
function interpolateZoomStops(v: unknown): Array<{ zoom: number; value: unknown }> | null {
  if (!Array.isArray(v) || v[0] !== 'interpolate') return null
  // Element 1 is the curve (we drop the type — xgis is linear-only).
  // Element 2 must be the `zoom` accessor.
  const input = v[2]
  if (!Array.isArray(input) || input[0] !== 'zoom') return null
  const stops: Array<{ zoom: number; value: unknown }> = []
  for (let i = 3; i + 1 < v.length; i += 2) {
    const z = v[i]
    if (typeof z !== 'number') return null
    stops.push({ zoom: z, value: v[i + 1] })
  }
  return stops.length >= 2 ? stops : null
}

/** Render a Mapbox interpolate-by-zoom expression as an xgis
 *  `interpolate(zoom, …)` call. The xgis evaluator handles the
 *  builtin uniformly — zoom-driven values evaluate per-frame,
 *  feature-driven values evaluate per-feature. The curve type
 *  (linear / exponential / cubic-bezier) is dropped; xgis is
 *  linear-only. Caller supplies an `emitValue` strategy that
 *  formats each stop value (colour, number, expression) into
 *  the bit that follows its zoom key.
 *
 *  Returns null when any stop value can't be formatted, so the
 *  caller can fall back to a more permissive path (e.g. take the
 *  first stop, or drop the property entirely). */
function interpolateZoomCall(
  v: unknown,
  warnings: string[],
  emitValue: (val: unknown, warnings: string[]) => string | null,
): string | null {
  const stops = interpolateZoomStops(v)
  if (!stops) return null
  const parts: string[] = []
  for (const s of stops) {
    const out = emitValue(s.value, warnings)
    if (out === null) return null
    parts.push(`${s.zoom}, ${out}`)
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
  if (s) out.push(`fill-${s}`)
}

function addStroke(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  const interp = interpolateZoomCall(v, warnings, (val, w) => colorToXgis(val, w))
  if (interp !== null) {
    out.push(`stroke-[${interp}]`)
    return
  }
  const s = colorToXgis(v, warnings)
  if (s) out.push(`stroke-${s}`)
}

function addStrokeWidth(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  const interp = interpolateZoomCall(v, warnings, (val) => typeof val === 'number' ? String(val) : null)
  if (interp !== null) {
    out.push(`stroke-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x === null) return
  // Tailwind-style suffix: number → `stroke-1.5`, expression → bracket form.
  out.push(`stroke-${maybeBracket(x)}`)
}

function addStrokeDash(out: string[], v: unknown, _warnings: string[]): void {
  if (!Array.isArray(v)) return
  const nums = v.filter(n => typeof n === 'number')
  if (nums.length < 2) return
  out.push('stroke-dasharray-' + nums.join('-'))
}

function addOpacity(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  if (typeof v === 'number') {
    // Mapbox 0..1, X-GIS opacity-N where N can be 0..100 or 0..1.
    out.push(`opacity-${v <= 1 ? Math.round(v * 100) : v}`)
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
  const interp = interpolateZoomCall(v, warnings, (val, w) => exprToXgis(val, w))
  if (interp !== null) {
    out.push(`fill-extrusion-base-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) out.push(`fill-extrusion-base-${maybeBracket(x)}`)
}
