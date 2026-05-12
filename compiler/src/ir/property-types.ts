// ═══════════════════════════════════════════════════════════════════
// PropertyShape — unified paint-property type (Plan Step 1)
// ═══════════════════════════════════════════════════════════════════
//
// X-GIS already has rich discriminated unions for each paint property
// at the RenderNode level (compiler/src/ir/render-node.ts):
//
//   ColorValue        — constant | data-driven | conditional |
//                       zoom-interpolated | time-interpolated | none
//   StrokeWidthValue  — constant | zoom-stops | feature-expr | …
//   OpacityValue      — constant | zoom-interpolated |
//                       time-interpolated | zoom-time | data-driven
//   SizeValue         — constant | zoom-interpolated |
//                       time-interpolated | data-driven | none
//
// But `emit-commands.ts` FLATTENS them into ShowCommand's mixed-bag
// fields (opacity: number | null + zoomOpacityStops: ZoomStop[] | null
// + timeOpacityStops + …), losing the type information that says
// "this property's truth-of-record is the stops, not the scalar".
//
// Downstream callsites (bucket-scheduler, VTR, line-renderer, map.ts
// composite) then have to RECONSTRUCT which field is authoritative
// per-frame. Any callsite that forgets a branch silently picks the
// wrong field — exactly the bug class this session has surfaced
// repeatedly (countries-boundary opacity stops missed in composite,
// `$zoom` lost in text-resolver, etc.).
//
// `PropertyShape<T>` is the canonical compiler-IR view of a paint
// property: a single discriminated union with one variant per
// "where does the value come from at evaluation time". Every paint
// property — colour, number, size, width — fits the same shape.
//
// The four kinds map to the four dependency classes in the Mapbox
// spec:
//
//   Static          — compile-time constant. No per-frame work.
//   ZoomOnly        — depends on camera.zoom only. Per-frame eval.
//   TimeOnly        — depends on animation clock only. Per-frame eval.
//   ZoomTime        — depends on both. Per-frame eval.
//   FeatureOnly     — depends on feature properties. Per-feature eval.
//   ZoomFeature     — depends on both zoom + feature. Worst case.
//
// Downstream consumers branch ONCE on the kind and pick the right
// evaluator. Callsites that forget a branch fail at compile time
// (the discriminated-union exhaustiveness check) instead of
// silently producing wrong output.

import type { ZoomStop, TimeStop, Easing, DataExpr } from './render-node'

// ─── PropertyShape<T> ──────────────────────────────────────────────

/** A paint property's evaluation shape. T is the property's value
 *  type (number for opacity / strokeWidth, [r,g,b,a] for colour,
 *  etc.). Each variant carries exactly the metadata that variant
 *  needs to evaluate — no nullable extras, no mixed-bag fields. */
export type PropertyShape<T> =
  /** Compile-time constant. Bucket scheduler treats this as a no-op
   *  during per-frame paint resolution. */
  | { kind: 'Static'; value: T }
  /** Zoom-interpolated. Per-frame evaluation against `camera.zoom`. */
  | {
      kind: 'ZoomOnly'
      stops: ZoomStop<T>[]
      /** Mapbox `["exponential", N]` curve base. Undefined or 1 → linear. */
      base?: number
    }
  /** Time-interpolated. Per-frame evaluation against the animation
   *  clock (elapsedMs). */
  | {
      kind: 'TimeOnly'
      stops: TimeStop<T>[]
      loop: boolean
      easing: Easing
      delayMs: number
    }
  /** Both zoom and time. Per-frame evaluation; the renderer
   *  multiplies the zoom factor by the time factor (opacity) or
   *  picks the dominant one (other properties). */
  | {
      kind: 'ZoomTime'
      zoomStops: ZoomStop<T>[]
      timeStops: TimeStop<T>[]
      loop: boolean
      easing: Easing
      delayMs: number
    }
  /** Feature-data-driven. Per-feature evaluation at decode time
   *  (baked into vertex attributes) or per-feature shader eval. */
  | { kind: 'FeatureOnly'; expr: DataExpr }
  /** Mixed feature + zoom dependency. expr's AST references both
   *  `zoom` and a feature property. Per-frame × per-feature evaluation
   *  — the worst case for performance. */
  | { kind: 'ZoomFeature'; expr: DataExpr }

/** A typed bundle of paint-property shapes for one ShowCommand.
 *  `null` for properties the layer doesn't author. This is the
 *  target shape ShowCommand will eventually carry directly (Step 1c
 *  of the plan); the converter in this PR populates it ALONGSIDE the
 *  legacy flat fields for backward compat. */
export interface PaintShapes {
  fill: PropertyShape<readonly [number, number, number, number]> | null
  stroke: PropertyShape<readonly [number, number, number, number]> | null
  opacity: PropertyShape<number>
  strokeWidth: PropertyShape<number>
  size: PropertyShape<number> | null
}

// ─── Helpers for emit-commands to populate PaintShapes ─────────────

/** RGBA tuple used by ColorValue. Imported as a readonly alias so
 *  callers can't mutate the stops array's value field by accident. */
export type RGBA = readonly [number, number, number, number]
