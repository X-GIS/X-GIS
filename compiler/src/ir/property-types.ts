// ═══════════════════════════════════════════════════════════════════
// PropertyShape — unified paint-property type (Plan Step 1)
// ═══════════════════════════════════════════════════════════════════
//
// X-GIS used to model each paint property with its own discriminated
// union — ColorValue, OpacityValue, StrokeWidthValue, SizeValue —
// despite all four being the same underlying shape ("value of type T
// + how it's evaluated"). The per-domain types differed only in:
//
//   - kind names ('zoom-stops' vs 'zoom-interpolated', 'per-feature'
//     vs 'data-driven') that meant the same thing
//   - whether `zoom-time` composition was supported (Opacity only,
//     arbitrary historical decision)
//   - field names for the constant variant ('value' vs 'px' vs 'rgba')
//
// User insight 2026-05-12: "the per-domain split is essentially
// defining a single number/RGBA wrapped in dependency metadata".
// Correct — they ARE the same shape. The per-domain split was an
// over-engineering artefact that bled into every consumer (each
// branch on a different set of kind strings) and made adding a new
// dependency form (zoom-time for stroke width) require touching N
// types.
//
// `PropertyShape<T>` is the single discriminated union. Every paint
// property — colour, opacity, stroke-width, size, future ones —
// instantiates it with its value type. The kind names match the
// historical RenderNode names so the type alias is a drop-in
// replacement, NOT a re-naming cascade through ~120 callsites.

import type { ZoomStop, TimeStop, Easing, DataExpr } from './render-node'

// ─── Shared atomic types ───────────────────────────────────────────

/** RGBA tuple. Readonly alias prevents callers from mutating a
 *  stops array's `value` field by accident. */
export type RGBA = readonly [number, number, number, number]

// ─── PropertyShape<T> ──────────────────────────────────────────────

/** A paint property's evaluation shape. T is the property's value
 *  type (number for opacity / stroke-width / size, [r,g,b,a] for
 *  colour, etc.). Five variants matching the five evaluation
 *  classes in the Mapbox spec, named to match the legacy RenderNode
 *  unions so existing callsites that switch on `kind` continue to
 *  compile unchanged. */
export type PropertyShape<T> =
  /** Compile-time constant — bucket scheduler treats this as a no-op
   *  during per-frame paint resolution. */
  | { kind: 'constant'; value: T }
  /** Per-frame evaluation against `camera.zoom`. Mapbox
   *  `["interpolate", curve, ["zoom"], …]`. */
  | {
      kind: 'zoom-interpolated'
      stops: ZoomStop<T>[]
      /** Mapbox `["exponential", N]` curve base. Undefined or 1 → linear. */
      base?: number
    }
  /** Per-frame evaluation against the animation clock (elapsedMs). */
  | {
      kind: 'time-interpolated'
      stops: TimeStop<T>[]
      loop: boolean
      easing: Easing
      delayMs: number
    }
  /** Both zoom and time. Renderer multiplies the zoom factor by the
   *  time factor (opacity) or picks the dominant one (other props). */
  | {
      kind: 'zoom-time'
      zoomStops: ZoomStop<T>[]
      timeStops: TimeStop<T>[]
      loop: boolean
      easing: Easing
      delayMs: number
    }
  /** Feature-data-driven. Worker bakes the evaluation into vertex
   *  attributes at tile-decode time. The expr's AST may also
   *  reference `zoom` — that's the worst-case "ZoomFeature" case,
   *  evaluated per-frame × per-feature; not split into a separate
   *  variant because the implementation path is identical (eval the
   *  AST against {feature props + camera-zoom prop}). */
  | { kind: 'data-driven'; expr: DataExpr }

/** PropertyShape bundle for a polygon / line ShowCommand. `null`
 *  fields mean the layer didn't author that axis — callers branch
 *  on null, not on a `kind: 'none'` sentinel. `opacity` and
 *  `strokeWidth` are non-null because they always resolve to a
 *  numeric value (lower.ts seeds defaults if the source omits them). */
export interface PaintShapes {
  /** Polygon fill colour. */
  fill: PropertyShape<RGBA> | null
  /** Line / polygon outline colour. */
  stroke: PropertyShape<RGBA> | null
  /** Layer-wide opacity multiplier (0..1). */
  opacity: PropertyShape<number>
  /** Line / outline width in CSS pixels. */
  strokeWidth: PropertyShape<number>
  /** Point / symbol size in CSS pixels. */
  size: PropertyShape<number> | null
}

/** PropertyShape bundle for one label's eight paint axes. The
 *  label-surface analogue of {@link PaintShapes}. Each axis is an
 *  independent shape so source-format expressions that vary one
 *  dimension at a time (e.g. font weight per feature with a fixed
 *  family stack) lower cleanly.
 *
 *  `null` fields mean the layer didn't author that axis. `size`
 *  is non-null because the runtime needs a numeric font size to
 *  rasterise — lower.ts seeds a constant with the spec default
 *  when the source omits text-size.
 *
 *  Consumers MUST NOT mix legacy `LabelDef.{size,color,halo,...}`
 *  fields with shapes at read time. The runtime resolves shapes →
 *  legacy in exactly one place (map.ts label paint resolution) and
 *  hands a resolved `effectiveDef` to text-stage. Downstream code
 *  (text-stage, curved-label paths, trace recorder) reads
 *  `effectiveDef.*` only. */
export interface LabelShapes {
  /** Font size in CSS pixels. */
  size: PropertyShape<number>
  /** Text fill colour. */
  color: PropertyShape<RGBA> | null
  /** Halo (outline) width in CSS pixels. */
  haloWidth: PropertyShape<number> | null
  /** Halo colour. */
  haloColor: PropertyShape<RGBA> | null
  /** Halo edge softness in CSS pixels (Gaussian-style feathering). */
  haloBlur: PropertyShape<number> | null
  /** Font family stack (analogous to CSS font-family — first
   *  available wins). Family names only; embedded weight / style
   *  suffixes are split into the parallel `fontWeight` / `fontStyle`
   *  shapes by the source-format converter. */
  font: PropertyShape<readonly string[]> | null
  /** CSS font-weight (100..900). */
  fontWeight: PropertyShape<number> | null
  /** CSS font-style. */
  fontStyle: PropertyShape<'normal' | 'italic'> | null
}
