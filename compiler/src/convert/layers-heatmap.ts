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
import { interpolateZoomCall, cssBezierEase } from './paint'
import { colorToXgis } from './colors'
import { resolveColorToRgba } from '../tokens/colors'
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
  // `["interpolate", …, ["heatmap-density"], stop0, color0, …]` (or the
  // `["step", ["heatmap-density"], …]` form). Lower the constant stops to
  // `heatmap-color-[interpolate(heatmap_density, o0, #hex0, …)]`; the
  // runtime bakes them into the 256×1 LUT (HeatmapRenderer rampBytes).
  // Unrecognisable forms warn + fall back to the default Mapbox ramp.
  const color = paint['heatmap-color']
  if (!isOmittedValue(color)) {
    const ramp = heatmapRampToXgis(color, layer.id, warnings)
    if (ramp !== null) utils.push(`heatmap-color-[${ramp}]`)
  }

  lines.push('  | ' + utils.join(' '))
  lines.push('}')
  return lines.join('\n')
}

// ── heatmap-color ramp lowering ──────────────────────────────────────

/** One resolved ramp stop: density offset 0..1 + straight-alpha RGBA 0..1. */
type RampStop = { offset: number; rgba: [number, number, number, number] }

/** Trim float noise from densified offsets (`0.30000000000000004` → `0.3`). */
function fmtOffset(n: number): string {
  return String(Math.round(n * 1e6) / 1e6)
}

function rgbaToHex8(rgba: [number, number, number, number]): string {
  const ch = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(rgba[0])}${ch(rgba[1])}${ch(rgba[2])}${ch(rgba[3])}`
}

function mixRgba(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ]
}

/** Lower a Mapbox `heatmap-color` ramp to the xgis bracket-binding call
 *  `interpolate(heatmap_density, o0, #rrggbbaa, o1, #rrggbbaa, …)`.
 *
 *  Accepted forms (constant colours only — the ramp is baked to a LUT):
 *   - `["interpolate", ["linear"], ["heatmap-density"], o, c, …]` — exact.
 *   - `["interpolate", ["exponential", b], …]` / `["interpolate",
 *     ["cubic-bezier", x1, y1, x2, y2], …]` — densified to piecewise-linear
 *     samples at convert time (6 per segment; the LUT interpolates linearly
 *     between stops, mirroring the zoom-interp bezier densify in paint.ts).
 *   - `["step", ["heatmap-density"], c0, o1, c1, …]` — each boundary emits
 *     two stops 1/1024 apart so the linear LUT reproduces the hard edge.
 *
 *  Returns null (+ warning) otherwise; the runtime default ramp applies. */
function heatmapRampToXgis(v: unknown, layerId: string, warnings: string[]): string | null {
  const fail = (why: string): null => {
    warnings.push(
      `Heatmap layer "${layerId}" — heatmap-color: ${why} — the runtime default density→colour ramp is applied.`,
    )
    return null
  }
  const isDensity = (x: unknown): boolean =>
    Array.isArray(x) && x.length === 1 && x[0] === 'heatmap-density'
  const stopColor = (x: unknown): [number, number, number, number] | null => {
    const hex = colorToXgis(x, warnings)
    return hex === null ? null : resolveColorToRgba(hex)
  }
  if (!Array.isArray(v) || typeof v[0] !== 'string') {
    return fail('value is not an interpolate/step expression')
  }

  const stops: RampStop[] = []
  if (v[0] === 'step') {
    // ["step", input, c0, o1, c1, o2, c2, …]
    if (!isDensity(v[1])) return fail('step input is not ["heatmap-density"]')
    if (v.length < 5 || v.length % 2 !== 1) return fail('malformed step stop list')
    const c0 = stopColor(v[2])
    if (c0 === null) return fail('step contains a non-constant colour')
    stops.push({ offset: 0, rgba: c0 })
    for (let i = 3; i + 1 < v.length; i += 2) {
      const o = v[i]
      const c = stopColor(v[i + 1])
      if (typeof o !== 'number' || !Number.isFinite(o) || o <= 0 || o > 1)
        return fail('step offsets must be numbers in (0, 1]')
      if (c === null) return fail('step contains a non-constant colour')
      const prev = stops[stops.length - 1]!
      if (o < prev.offset) return fail('step offsets must be ascending')
      // Hard edge: hold the previous colour until just before the boundary.
      stops.push({ offset: Math.max(prev.offset, o - 1 / 1024), rgba: prev.rgba })
      stops.push({ offset: o, rgba: c })
    }
  } else if (v[0] === 'interpolate') {
    // ["interpolate", curve, input, o0, c0, o1, c1, …]
    let curve: unknown = v[1]
    while (Array.isArray(curve) && curve.length === 2 && curve[0] === 'literal') curve = curve[1]
    if (!Array.isArray(curve) || typeof curve[0] !== 'string')
      return fail('malformed interpolation curve')
    if (!isDensity(v[2])) return fail('interpolate input is not ["heatmap-density"]')
    if (v.length < 7 || v.length % 2 !== 1) return fail('malformed interpolate stop list')
    const raw: RampStop[] = []
    for (let i = 3; i + 1 < v.length; i += 2) {
      const o = v[i]
      const c = stopColor(v[i + 1])
      if (typeof o !== 'number' || !Number.isFinite(o) || o < 0 || o > 1)
        return fail('interpolate offsets must be numbers in [0, 1]')
      if (c === null) return fail('interpolate contains a non-constant colour')
      if (raw.length > 0 && o < raw[raw.length - 1]!.offset)
        return fail('interpolate offsets must be ascending')
      raw.push({ offset: o, rgba: c })
    }
    const curveName = curve[0]
    if (curveName === 'linear') {
      stops.push(...raw)
    } else if (curveName === 'exponential' || curveName === 'cubic-bezier') {
      // Densify each segment to 6 linear samples (the LUT lerps between
      // stops, so a piecewise-linear approximation of the eased curve is
      // what the GPU would see anyway at 256-texel resolution).
      let base = 1
      let bx1 = 0,
        by1 = 0,
        bx2 = 1,
        by2 = 1
      if (curveName === 'exponential') {
        const b = curve[1]
        if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0)
          return fail('malformed exponential base')
        base = b
      } else {
        const [, x1, y1, x2, y2] = curve
        if (
          typeof x1 !== 'number' ||
          typeof y1 !== 'number' ||
          typeof x2 !== 'number' ||
          typeof y2 !== 'number'
        )
          return fail('malformed cubic-bezier control points')
        bx1 = x1
        by1 = y1
        bx2 = x2
        by2 = y2
      }
      const SAMPLES = 6
      stops.push(raw[0]!)
      for (let s = 0; s + 1 < raw.length; s++) {
        const a = raw[s]!
        const b = raw[s + 1]!
        const span = b.offset - a.offset
        for (let k = 1; k <= SAMPLES; k++) {
          const u = k / SAMPLES
          let t: number
          if (curveName === 'exponential') {
            t = base === 1 ? u : (Math.pow(base, u * span) - 1) / (Math.pow(base, span) - 1)
          } else {
            t = cssBezierEase(u, bx1, by1, bx2, by2)
          }
          stops.push({ offset: a.offset + span * u, rgba: mixRgba(a.rgba, b.rgba, t) })
        }
      }
    } else {
      return fail(`unknown interpolation curve "${String(curveName).slice(0, 30)}"`)
    }
  } else {
    return fail(`unsupported expression ["${v[0].slice(0, 30)}", …]`)
  }

  if (stops.length < 2) return fail('ramp needs at least two stops')
  const parts = stops.map((s) => `${fmtOffset(s.offset)}, ${rgbaToHex8(s.rgba)}`)
  return `interpolate(heatmap_density, ${parts.join(', ')})`
}
