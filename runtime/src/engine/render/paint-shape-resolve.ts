// ═══ PropertyShape resolvers ═══
//
// Per-frame evaluation of PaintShapes' five PropertyShape variants:
//
//   constant            → no per-frame work (caller uses static value)
//   zoom-interpolated   → interpolateZoom(stops, cameraZoom, base)
//   time-interpolated   → interpolateTime(stops, elapsedMs, …)
//   zoom-time           → zoomFactor × timeFactor (the spec's
//                         composition rule for opacity; reused for
//                         numeric properties so callers don't branch)
//   data-driven         → per-layer fallback of 1 (or null for RGBA);
//                         the worker handles the per-feature path
//                         downstream
//
// Hoisted from bucket-scheduler.ts so MapRenderer / PointRenderer
// and any future consumer can resolve PropertyShapes from a single
// definition. Interpolators live in renderer.ts to keep the math
// where the legacy MapRenderer composer expected them; that path is
// being phased out alongside Step 1d but the helpers remain
// authoritative as the migration completes.

import type { PropertyShape } from '@xgis/compiler'
import {
  interpolateZoom, interpolateZoomRgba, interpolateTime, interpolateTimeColor,
} from './renderer'

/** Compact representation of "value plus how it was computed". The
 *  `hasZoom` / `hasTime` flags drive the bucket-scheduler's
 *  zero-allocation clone decision — when neither is set the per-frame
 *  resolved value equals the static `kind: 'constant'` payload and
 *  there's no reason to clone the show object. */
export interface ResolvedNumber {
  value: number
  hasZoom: boolean
  hasTime: boolean
}

/** RGBA companion to {@link ResolvedNumber}. The renderer reuses the
 *  same allocation conventions — `null` from {@link resolveColorShape}
 *  means "the static fill hex / per-feature bake is authoritative for
 *  this frame; no clone needed". */
export interface ResolvedColor {
  value: readonly [number, number, number, number]
  hasZoom: boolean
  hasTime: boolean
}

/** Evaluate a `PropertyShape<number>` to a per-frame scalar plus
 *  contributor flags. See module header for the five-variant rule. */
export function resolveNumberShape(
  shape: PropertyShape<number>,
  cameraZoom: number,
  elapsedMs: number,
): ResolvedNumber {
  switch (shape.kind) {
    case 'constant':
      return { value: shape.value, hasZoom: false, hasTime: false }
    case 'zoom-interpolated':
      return {
        value: interpolateZoom(shape.stops, cameraZoom, shape.base ?? 1),
        hasZoom: true, hasTime: false,
      }
    case 'time-interpolated':
      return {
        value: interpolateTime(shape.stops, elapsedMs, shape.loop, shape.easing, shape.delayMs),
        hasZoom: false, hasTime: true,
      }
    case 'zoom-time': {
      const zoomFactor = interpolateZoom(shape.zoomStops, cameraZoom, 1)
      const timeFactor = interpolateTime(
        shape.timeStops, elapsedMs, shape.loop, shape.easing, shape.delayMs,
      )
      return { value: zoomFactor * timeFactor, hasZoom: true, hasTime: true }
    }
    case 'data-driven':
      return { value: 1, hasZoom: false, hasTime: false }
  }
}

/** RGBA companion to {@link resolveNumberShape}. Returns `null` for
 *  `constant` and `data-driven` — callers continue to use the static
 *  hex (constant) or the per-feature bake (data-driven). */
export function resolveColorShape(
  shape: PropertyShape<readonly [number, number, number, number]>,
  cameraZoom: number,
  elapsedMs: number,
): ResolvedColor | null {
  switch (shape.kind) {
    case 'constant':
      return null
    case 'zoom-interpolated':
      return {
        value: interpolateZoomRgba(shape.stops as { zoom: number; value: [number, number, number, number] }[], cameraZoom, shape.base ?? 1) as readonly [number, number, number, number],
        hasZoom: true, hasTime: false,
      }
    case 'time-interpolated':
      return {
        value: interpolateTimeColor(
          shape.stops as { timeMs: number; value: [number, number, number, number] }[], elapsedMs,
          shape.loop, shape.easing, shape.delayMs,
        ) as readonly [number, number, number, number],
        hasZoom: false, hasTime: true,
      }
    case 'zoom-time': {
      // Spec doesn't define zoom × time composition for colour; pick
      // the time-axis value (the dominant animation in observed
      // styles). emit-commands doesn't currently produce zoom-time
      // colour shapes — this branch is defensive only.
      return {
        value: interpolateTimeColor(
          shape.timeStops as { timeMs: number; value: [number, number, number, number] }[], elapsedMs,
          shape.loop, shape.easing, shape.delayMs,
        ) as readonly [number, number, number, number],
        hasZoom: true, hasTime: true,
      }
    }
    case 'data-driven':
      return null
  }
}

/** `true` when a PropertyShape's `kind` carries a per-frame zoom or
 *  time dependency — i.e. its resolved value depends on
 *  cameraZoom/elapsedMs and may differ from frame to frame. Used by
 *  the clone decision in the bucket scheduler so static shows stay
 *  on the zero-allocation hot path. */
export function hasZoomOrTime(shape: PropertyShape<unknown>): boolean {
  return shape.kind === 'zoom-interpolated'
    || shape.kind === 'time-interpolated'
    || shape.kind === 'zoom-time'
}
