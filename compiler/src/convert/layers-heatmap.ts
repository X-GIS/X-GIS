// ═══ Mapbox heatmap layer → xgis conversion (Phase R) ═══
//
// Converts a Mapbox `heatmap` layer (Point/MultiPoint density visualisation)
// into an xgis `layer <id> { … | heatmap … }` block. The X-GIS runtime's
// HeatmapRenderer (3-pass accum → blur → compose) is the destination; the
// `heatmap` marker utility routes the layer there in map.ts.
//
// Property mapping (paint):
//   heatmap-radius    → `heatmap-radius-N`     (CSS px Gaussian footprint; zoom-interp → bracket)
//   heatmap-weight    → `heatmap-weight-N`     (per-feature contribution multiplier; default 1)
//   heatmap-intensity → `heatmap-intensity-N`  (overall density scale; zoom-interp → bracket)
//   heatmap-opacity   → `heatmap-opacity-N`    (layer alpha 0..1)
//   heatmap-color     → `heatmap-color-[expr]` (interpolate over ["heatmap-density"]; the runtime
//                                               bakes the ramp into a 256×1 LUT — constant default
//                                               used when absent)
//
// Data-driven (per-feature) heatmap-weight is carried through exprToXgis;
// other non-constant forms beyond zoom-interp warn + fall back to the default.

import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { exprToXgis } from './expressions'
import { interpolateZoomCall } from './paint'
import {
  unwrapLiteralScalar,
  safePropsBag,
  isOmittedValue,
  filterLineOrFailClosed,
} from './layers-helpers'

export function convertHeatmapLayer(layer: MapboxLayer, warnings: string[]): string {
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
  const heatmapFilterLine = filterLineOrFailClosed(layer.filter, warnings)
  if (heatmapFilterLine !== null) lines.push(heatmapFilterLine)
  const visibility = unwrapLiteralScalar(layout['visibility'])
  if (visibility === 'none') {
    lines.push(`  visible: false`)
  } else if (typeof visibility === 'string' && visibility !== 'visible') {
    warnings.push(
      `Heatmap layer "${layer.id}" — visibility "${visibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`,
    )
  }

  // The `heatmap` marker utility — routes this layer to the runtime
  // HeatmapRenderer (map.ts heatmap fork) instead of the polygon/point path.
  const utils: string[] = ['heatmap']

  // heatmap-radius → heatmap-radius-N. CSS px. Default 30 per Mapbox spec.
  const radius = unwrapLiteralScalar(paint['heatmap-radius'])
  if (typeof radius === 'number' && Number.isFinite(radius)) {
    utils.push(`heatmap-radius-${Math.max(1, radius)}`)
  } else if (radius !== undefined && radius !== null) {
    const interp = interpolateZoomCall(paint['heatmap-radius'], warnings, (val) =>
      typeof val === 'number' && Number.isFinite(val) ? String(Math.max(1, val)) : null,
    )
    if (interp !== null) utils.push(`heatmap-radius-[${interp}]`)
    else {
      warnings.push(
        `Heatmap layer "${layer.id}" — heatmap-radius: non-constant form not supported — default 30 used.`,
      )
      utils.push('heatmap-radius-30')
    }
  } else {
    utils.push('heatmap-radius-30')
  }

  // heatmap-weight → heatmap-weight-N. Per-feature multiplier. Default 1.
  const weight = unwrapLiteralScalar(paint['heatmap-weight'])
  if (typeof weight === 'number' && Number.isFinite(weight)) {
    utils.push(`heatmap-weight-${Math.max(0, weight)}`)
  } else if (weight !== undefined && weight !== null) {
    // Per-feature (data-driven) weight → bracket binding for runtime eval.
    const expr = exprToXgis(paint['heatmap-weight'], warnings)
    if (expr !== null) utils.push(`heatmap-weight-[${expr}]`)
    else utils.push('heatmap-weight-1')
  } else {
    utils.push('heatmap-weight-1')
  }

  // heatmap-intensity → heatmap-intensity-N. Overall scale. Default 1.
  const intensity = unwrapLiteralScalar(paint['heatmap-intensity'])
  if (typeof intensity === 'number' && Number.isFinite(intensity)) {
    utils.push(`heatmap-intensity-${Math.max(0, intensity)}`)
  } else if (intensity !== undefined && intensity !== null) {
    const interp = interpolateZoomCall(paint['heatmap-intensity'], warnings, (val) =>
      typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null,
    )
    if (interp !== null) utils.push(`heatmap-intensity-[${interp}]`)
    else {
      warnings.push(
        `Heatmap layer "${layer.id}" — heatmap-intensity: non-constant form not supported — default 1 used.`,
      )
      utils.push('heatmap-intensity-1')
    }
  } else {
    utils.push('heatmap-intensity-1')
  }

  // heatmap-opacity → heatmap-opacity-N (0..1). Default 1.
  const opacity = unwrapLiteralScalar(paint['heatmap-opacity'])
  if (typeof opacity === 'number' && Number.isFinite(opacity)) {
    utils.push(`heatmap-opacity-${Math.max(0, Math.min(1, opacity))}`)
  } else if (opacity !== undefined && opacity !== null) {
    const interp = interpolateZoomCall(paint['heatmap-opacity'], warnings, (val) =>
      typeof val === 'number' && Number.isFinite(val)
        ? String(Math.max(0, Math.min(1, val)))
        : null,
    )
    if (interp !== null) utils.push(`heatmap-opacity-[${interp}]`)
    else {
      warnings.push(
        `Heatmap layer "${layer.id}" — heatmap-opacity: non-constant form not supported — default 1 used.`,
      )
      utils.push('heatmap-opacity-1')
    }
  } else {
    utils.push('heatmap-opacity-1')
  }

  // heatmap-color → density→colour ramp. The Mapbox value is an
  // `["interpolate", …, ["heatmap-density"], stop0, color0, …]`. A custom
  // ramp is not yet baked into the runtime LUT — the HeatmapRenderer applies
  // its default Mapbox ramp. Surface the gap; the converter still references
  // the property so the coverage drift detector tracks it.
  const color = paint['heatmap-color']
  if (!isOmittedValue(color)) {
    warnings.push(
      `Heatmap layer "${layer.id}" — custom heatmap-color ramp not yet honoured; the runtime default density→colour ramp is applied.`,
    )
  }

  lines.push('  | ' + utils.join(' '))
  lines.push('}')
  return lines.join('\n')
}
