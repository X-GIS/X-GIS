// Mapbox `paint` properties → xgis utility-class array. Thin dispatcher:
// the per-layer-type emitter groups live in paint-fill.ts / paint-line.ts
// / paint-fill-extrusion.ts / paint-raster.ts (one add*/emit module per
// layer type so two future changes in different layer types touch
// different files). This module routes each layer to its emitter group
// in the exact same order as before.
//
// Zoom-driven values (Mapbox `["interpolate", curve, ["zoom"], …]`)
// are wrapped into a single `interpolate(zoom, …)` xgis builtin
// inside a bracket binding — see `interpolateZoomCall` in paint-helpers.
// Non-zoom interpolate falls through to per-feature data-driven
// path handled by `exprToXgis`.

import type { MapboxLayer } from './types'
import { emitFillPaint } from './paint-fill'
import { emitLinePaint } from './paint-line'
import { emitFillExtrusionPaint } from './paint-fill-extrusion'
import { emitRasterPaint } from './paint-raster'
// Re-export public helpers so importers of './paint' keep their surface.
export { cssBezierEase, interpolateZoomCall } from './paint-helpers'

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
    emitFillPaint(out, layer, p, warnings)
  } else if (layer.type === 'line') {
    emitLinePaint(out, layer, p, warnings)
  } else if (layer.type === 'fill-extrusion') {
    emitFillExtrusionPaint(out, layer, p, warnings)
  } else if (layer.type === 'raster') {
    emitRasterPaint(out, layer, p, warnings)
  }

  return out
}
