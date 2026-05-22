// ═══ X-GIS Map Renderer — pure helpers ═══
//
// Top-level pure free functions (no `this`, no module mutable state,
// no side effects) extracted verbatim from renderer.ts. renderer.ts
// re-exports the previously-exported interpolators so the public module
// surface stays byte-identical; `parseColor` is internal and imported
// without re-export.

import type { Easing } from './renderer-types'

// ═══ Color parsing ═══

export function parseColor(hex: string): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 1
  // Reject non-hex content early. Mirror of the feature-helpers
  // parseHexColor regex gate (caad699) — without it `parseInt('zz',
  // 16)` = NaN propagated to colour channels and the GPU sampled
  // undefined behaviour.
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
    return [0, 0, 0, 1]
  }
  if (hex.length === 4) {
    // #RGB
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 5) {
    // #RGBA — CSS Color Module 4 short-alpha. Pre-fix this length
    // fell to the [0,0,0,1] default; mirror of the feature-helpers
    // parseHexColor fix (6acc299).
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
    a = parseInt(hex[4] + hex[4], 16) / 255
  } else if (hex.length === 7) {
    // #RRGGBB
    r = parseInt(hex.substring(1, 3), 16) / 255
    g = parseInt(hex.substring(3, 5), 16) / 255
    b = parseInt(hex.substring(5, 7), 16) / 255
  } else if (hex.length === 9) {
    // #RRGGBBAA
    r = parseInt(hex.substring(1, 3), 16) / 255
    g = parseInt(hex.substring(3, 5), 16) / 255
    b = parseInt(hex.substring(5, 7), 16) / 255
    a = parseInt(hex.substring(7, 9), 16) / 255
  }
  return [r, g, b, a]
}

/** Interpolate between sorted zoom stops.
 *
 *  `base` is the Mapbox `["exponential", base]` curve parameter — when
 *  unset or 1, falls through to linear interpolation. When > 1, the
 *  fraction t accelerates near the higher zoom stop (lines / dots
 *  grow fast as you zoom in); when 0 < base < 1, t accelerates near
 *  the lower stop. Formula matches Mapbox / MapLibre:
 *
 *      t = (base^(z - z_i) - 1) / (base^(z_{i+1} - z_i) - 1)
 *
 *  Defaults to linear so the 99 % of call sites that don't carry an
 *  exponential curve continue to behave identically. */
export function interpolateZoom(
  stops: { zoom: number; value: number }[],
  zoom: number,
  base: number = 1,
): number {
  if (stops.length === 0) return 1.0
  if (zoom <= stops[0].zoom) return stops[0].value
  if (zoom >= stops[stops.length - 1].zoom) return stops[stops.length - 1].value
  for (let i = 0; i < stops.length - 1; i++) {
    if (zoom >= stops[i].zoom && zoom <= stops[i + 1].zoom) {
      const z0 = stops[i].zoom
      const z1 = stops[i + 1].zoom
      const span = z1 - z0
      let t: number
      // Guard duplicate-zoom stops (z0 === z1) to avoid divide-by-zero
      // → Infinity → NaN propagation. Mirror of the exponential path
      // `denom === 0 ? 0 : ...` guard below + the compiler evaluator
      // duplicate-x guard.
      if (span === 0) {
        t = 0
      } else if (base === 1 || Math.abs(base - 1) < 1e-6) {
        t = (zoom - z0) / span
      } else {
        // Exponential. Math.pow handles base > 1 and 0 < base < 1.
        const numer = Math.pow(base, zoom - z0) - 1
        const denom = Math.pow(base, span) - 1
        t = denom === 0 ? 0 : numer / denom
      }
      return stops[i].value + t * (stops[i + 1].value - stops[i].value)
    }
  }
  return stops[stops.length - 1].value
}

/** RGBA component-wise zoom interpolation. Sibling of interpolateZoom
 *  but for the [r,g,b,a] tuples Mapbox text-color / text-halo-color
 *  stops produce. Returns a freshly allocated tuple — call sites are
 *  per-frame-per-label so allocation is cheap relative to the GPU
 *  work, and aliasing an `out` buffer would be brittle. */
export function interpolateZoomRgba(
  stops: { zoom: number; value: [number, number, number, number] }[],
  zoom: number,
  base: number = 1,
): [number, number, number, number] {
  if (stops.length === 0) return [0, 0, 0, 1]
  if (zoom <= stops[0].zoom) {
    const v = stops[0].value
    return [v[0], v[1], v[2], v[3]]
  }
  if (zoom >= stops[stops.length - 1].zoom) {
    const v = stops[stops.length - 1].value
    return [v[0], v[1], v[2], v[3]]
  }
  for (let i = 0; i < stops.length - 1; i++) {
    if (zoom >= stops[i].zoom && zoom <= stops[i + 1].zoom) {
      const z0 = stops[i].zoom
      const z1 = stops[i + 1].zoom
      const span = z1 - z0
      let t: number
      // Duplicate-zoom guard — mirror of the scalar interpolateZoom
      // fix. Pre-fix `(zoom - z0) / 0` → Infinity → component-wise
      // NaN colour, GPU sampled undefined behaviour.
      if (span === 0) {
        t = 0
      } else if (base === 1 || Math.abs(base - 1) < 1e-6) {
        t = (zoom - z0) / span
      } else {
        const numer = Math.pow(base, zoom - z0) - 1
        const denom = Math.pow(base, span) - 1
        t = denom === 0 ? 0 : numer / denom
      }
      const a = stops[i].value, b = stops[i + 1].value
      return [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        a[2] + t * (b[2] - a[2]),
        a[3] + t * (b[3] - a[3]),
      ]
    }
  }
  const v = stops[stops.length - 1].value
  return [v[0], v[1], v[2], v[3]]
}

/** Easing functions applied between adjacent time stops. Maps t∈[0,1] → [0,1]. */
const EASING_LUT: Record<Easing, (t: number) => number> = {
  'linear':      (t) => t,
  'ease-in':     (t) => t * t,
  'ease-out':    (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
}

/**
 * Linearly interpolate between sorted time stops, with easing applied to
 * the per-segment t. Mirrors interpolateZoom() but operates on milliseconds
 * instead of zoom levels, and supports loop / delay / easing semantics.
 *
 * - `elapsedMs` is the global wall clock since animation start
 * - `loop=true` wraps elapsed modulo the last stop's timeMs
 * - `delayMs` is subtracted before sampling (may be negative to "start mid")
 * - `easing` warps the per-segment t before the lerp
 *
 * Returns the first stop's value when no stops exist or we're before the
 * first stop (after delay adjustment). Returns the last stop's value when
 * we're past the end and loop=false.
 */
export function interpolateTime(
  stops: { timeMs: number; value: number }[],
  elapsedMs: number,
  loop: boolean,
  easing: Easing,
  delayMs: number,
): number {
  if (stops.length === 0) return 1.0
  const effective = elapsedMs - delayMs
  if (effective < 0) return stops[0].value
  const last = stops[stops.length - 1].timeMs
  const t = loop && last > 0 ? effective % last : Math.min(effective, last)
  if (t <= stops[0].timeMs) return stops[0].value
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].timeMs && t <= stops[i + 1].timeMs) {
      const span = stops[i + 1].timeMs - stops[i].timeMs
      if (span === 0) return stops[i + 1].value
      const raw = (t - stops[i].timeMs) / span
      const k = EASING_LUT[easing](raw)
      return stops[i].value + k * (stops[i + 1].value - stops[i].value)
    }
  }
  return stops[stops.length - 1].value
}

/**
 * Componentwise-RGB version of interpolateTime for color animations.
 * Writes the interpolated value into `out` (caller-provided, avoids
 * per-frame allocations) and returns it.
 *
 * Uses naive linear RGB lerp. A future PR may add per-keyframes
 * colorspace annotations (e.g. `in oklch`) — that's noted as out of
 * scope in the animation roadmap.
 */
export function interpolateTimeColor(
  stops: { timeMs: number; value: [number, number, number, number] }[],
  elapsedMs: number,
  loop: boolean,
  easing: Easing,
  delayMs: number,
  out: [number, number, number, number] = [0, 0, 0, 0],
): [number, number, number, number] {
  if (stops.length === 0) { out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1; return out }
  const effective = elapsedMs - delayMs
  if (effective < 0) {
    const v = stops[0].value
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
    return out
  }
  const last = stops[stops.length - 1].timeMs
  const t = loop && last > 0 ? effective % last : Math.min(effective, last)
  if (t <= stops[0].timeMs) {
    const v = stops[0].value
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
    return out
  }
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].timeMs && t <= stops[i + 1].timeMs) {
      const span = stops[i + 1].timeMs - stops[i].timeMs
      if (span === 0) {
        const v = stops[i + 1].value
        out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
        return out
      }
      const raw = (t - stops[i].timeMs) / span
      const k = EASING_LUT[easing](raw)
      const a = stops[i].value, b = stops[i + 1].value
      out[0] = a[0] + k * (b[0] - a[0])
      out[1] = a[1] + k * (b[1] - a[1])
      out[2] = a[2] + k * (b[2] - a[2])
      out[3] = a[3] + k * (b[3] - a[3])
      return out
    }
  }
  const v = stops[stops.length - 1].value
  out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3]
  return out
}
