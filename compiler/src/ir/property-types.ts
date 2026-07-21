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
      /** Mapbox `["exponential", N]` curve base on the zoom axis.
       *  Undefined / 1 → linear. Preserved through the zoom-time
       *  merge so exponential interp doesn't silently collapse to
       *  linear when a time animation is also active. */
      zoomBase?: number
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

// ─── PaintShapes sub-bundles (Tier-B B1, row 15) ───────────────────
//
// PaintShapes was a flat record where every layer-type's paint axis
// sat side-by-side, so a fill-axis change and a line-axis change both
// edited the same single-authority bundle (a serialization chokepoint
// on the parity path). It is now sub-bundled BY LAYER TYPE so those
// edits land in different sub-groups → parallel-safe. This is PURE
// grouping: the same PropertyShape values, the same field names, just
// nested one level under the layer type they belong to.

/** Polygon fill paint axes. */
export interface FillShapes {
  /** Polygon fill colour. */
  fill: PropertyShape<RGBA> | null
}

/** Line / polygon-outline paint axes. */
export interface LineShapes {
  /** Line / polygon outline colour. */
  stroke: PropertyShape<RGBA> | null
  /** Line / outline width in CSS pixels. */
  strokeWidth: PropertyShape<number>
}

/** Circle / point-marker paint axes. */
export interface CircleShapes {
  /** Point / symbol size in CSS pixels. */
  size: PropertyShape<number> | null
}

/** Layer-wide paint axes shared across every layer type. */
export interface CommonPaintShapes {
  /** Layer-wide opacity multiplier (0..1). */
  opacity: PropertyShape<number>
}

/** Raster fragment colour adjustments (Mapbox `raster-*`). Each axis is a
 *  numeric PropertyShape (constant in practice) carrying the spec default
 *  when the layer didn't author it, so the runtime resolve is a hard no-op
 *  by default. `resamplingNearest` is the only non-numeric axis (sampler
 *  filter selector); false (default) = linear, byte-identical to today. */
export interface RasterShapes {
  hueRotate: PropertyShape<number>
  brightnessMin: PropertyShape<number>
  brightnessMax: PropertyShape<number>
  saturation: PropertyShape<number>
  contrast: PropertyShape<number>
  resamplingNearest: boolean
}

/** Spec-default raster colour adjustments (all no-ops). Returned fresh on
 *  each call so callers building a ShowCommand can't alias a shared mutable
 *  literal. Used by every non-raster ShowCommand constructor (synthetic
 *  shows / interpreter / tests) so adding a raster axis stays one-line. */
export function defaultRasterShapes(): RasterShapes {
  return {
    hueRotate: { kind: 'constant', value: 0 },
    brightnessMin: { kind: 'constant', value: 0 },
    brightnessMax: { kind: 'constant', value: 1 },
    saturation: { kind: 'constant', value: 0 },
    contrast: { kind: 'constant', value: 0 },
    resamplingNearest: false,
  }
}

/** Mapbox `hillshade-method` gradient-shading algorithm. All five MapLibre
 *  v5 models are implemented in fs_hillshade: `standard` (legacy default,
 *  byte-parity target), `basic` (GDAL Lambert), `combined`, `igor`, and
 *  `multidirectional` (up to 4 averaged Lambert sources). */
export type HillshadeMethod = 'standard' | 'basic' | 'combined' | 'igor' | 'multidirectional'

/** One extra illumination source (2..4) for `hillshade-method:
 *  multidirectional` — the only method the spec allows multiple sources
 *  for. Fully-resolved constants; the converter already normalised the
 *  spec's numberArray/colorArray per MapLibre (pad by repeating the last
 *  element) and truncated to the 4-source uniform budget. */
export interface HillshadeExtraSourceShape {
  /** azimuth, deg from N. */
  direction: number
  /** altitude, deg (0–90). */
  altitude: number
  shadow: RGBA
  highlight: RGBA
}

/** Hillshade DEM-relief paint axes (Mapbox `hillshade-*`). Mirror of
 *  {@link RasterShapes}: each axis carries the spec default when the layer
 *  didn't author it, so the hillshade renderer resolves a no-op by
 *  default. `direction` / `altitude` / `shadow` / `highlight` are source 1
 *  (element 0 of the spec's numberArray/colorArray); multidirectional
 *  sources 2..4 ride {@link HillshadeShapes.extraSources}. */
export interface HillshadeShapes {
  /** `hillshade-illumination-direction` — light azimuth in degrees from N
   *  clockwise. Default 335. */
  direction: PropertyShape<number>
  /** `hillshade-illumination-altitude` — light elevation angle (0–90°).
   *  Default 45. */
  altitude: PropertyShape<number>
  /** `hillshade-illumination-anchor` = "map" (default "viewport" = false).
   *  When true the light is anchored to data-space (north); viewport
   *  follows the camera bearing. */
  anchorMap: boolean
  /** `hillshade-exaggeration` — vertical-relief multiplier. Default 0.5. */
  exaggeration: PropertyShape<number>
  /** `hillshade-shadow-color` — shadow-side RGBA. Default #000000. */
  shadow: PropertyShape<RGBA>
  /** `hillshade-highlight-color` — lit-side RGBA. Default #FFFFFF. */
  highlight: PropertyShape<RGBA>
  /** `hillshade-accent-color` — accent tint RGBA. Default #000000. */
  accent: PropertyShape<RGBA>
  /** `hillshade-method` — DEM gradient-shading algorithm. Default standard. */
  method: HillshadeMethod
  /** `resampling: nearest` flag (spec default `linear` = false). Mirror of
   *  RasterShapes.resamplingNearest — false = linear sampler over the
   *  decoded DEM height field. */
  resamplingNearest: boolean
  /** Illumination sources 2..4 (method=multidirectional). Empty for
   *  single-source layers — byte-identical to the pre-multidirectional IR. */
  extraSources: readonly HillshadeExtraSourceShape[]
}

/** Spec-default hillshade paint axes (all no-ops). Returned fresh on each
 *  call so callers can't alias a shared mutable literal. Mirror of
 *  {@link defaultRasterShapes} — the (future) renderer / synthetic shows /
 *  tests seed this so adding a hillshade axis stays one-line. */
export function defaultHillshadeShapes(): HillshadeShapes {
  return {
    direction: { kind: 'constant', value: 335 },
    altitude: { kind: 'constant', value: 45 },
    anchorMap: false,
    exaggeration: { kind: 'constant', value: 0.5 },
    shadow: { kind: 'constant', value: [0, 0, 0, 1] },
    highlight: { kind: 'constant', value: [1, 1, 1, 1] },
    accent: { kind: 'constant', value: [0, 0, 0, 1] },
    method: 'standard',
    resamplingNearest: false,
    extraSources: [],
  }
}

/** PropertyShape bundle for a polygon / line ShowCommand, sub-bundled
 *  per layer type. `null` fields mean the layer didn't author that
 *  axis — callers branch on null, not on a `kind: 'none'` sentinel.
 *  `common.opacity` and `line.strokeWidth` are non-null because they
 *  always resolve to a numeric value (lower.ts seeds defaults if the
 *  source omits them). */
export interface PaintShapes {
  fill: FillShapes
  line: LineShapes
  circle: CircleShapes
  common: CommonPaintShapes
  /** Raster colour adjustments. Present on every ShowCommand (defaults are
   *  no-ops); only the raster renderer reads it, via the active raster show. */
  raster: RasterShapes
  /** Hillshade DEM-relief axes. Optional — present ONLY on a hillshade
   *  layer's ShowCommand (the converter authored at least one hillshade
   *  axis). Absent on every other layer type, so the
   *  hillshade renderer branches on presence and falls back to
   *  {@link defaultHillshadeShapes} when a raster-dem draw carries no
   *  authored paint. Mirrors the optionality of `HeatmapPaint.isHeatmap`. */
  hillshade?: HillshadeShapes
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
// ─── LabelShapes sub-bundles (Tier-B B1, row 15) ───────────────────
//
// LabelShapes' eight text axes + three icon axes are now sub-bundled
// BY CONCERN — text-paint vs text-layout vs icon — so a text-paint
// change and an icon change touch different sub-groups. PURE grouping:
// same PropertyShape values, same field names, nested under their
// concern.

/** Text PAINT axes (colour / halo / opacity). */
export interface TextPaintShapes {
  /** Text fill colour. */
  color: PropertyShape<RGBA> | null
  /** Halo (outline) width in CSS pixels. */
  haloWidth: PropertyShape<number> | null
  /** Halo colour. */
  haloColor: PropertyShape<RGBA> | null
  /** Halo edge softness in CSS pixels (Gaussian-style feathering). */
  haloBlur: PropertyShape<number> | null
  /** Mapbox `text-opacity` 0..1 alpha multiplier on the resolved
   *  text fill colour. `null` = no author input. The constant form
   *  is still folded into `color`'s alpha at convert-time
   *  (applyAlphaMultiplier — single label-color hex carries both).
   *  Zoom-interp / data-driven forms land here and the runtime
   *  multiplies `resolvedColor.a` (+ halo colour alpha) per frame.
   *  Iter 113. */
  opacity: PropertyShape<number> | null
}

/** Text LAYOUT axes (size / font). */
export interface TextLayoutShapes {
  /** Font size in CSS pixels. */
  size: PropertyShape<number>
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

/** Sprite ICON axes (size / opacity / colour). */
export interface IconShapes {
  /** Mapbox `icon-size` scale factor on the sprite's design size.
   *  `null` = no author input → runtime falls back to LabelDef.iconSize
   *  (constant) or the spec default 1. Constant + zoom-interp both
   *  resolve to a number; data-driven not yet supported (iter 523). */
  iconSize: PropertyShape<number> | null
  /** Mapbox `icon-opacity` 0..1 alpha multiplier on the sprite quad.
   *  `null` = no author input → runtime falls back to LabelDef.iconOpacity
   *  (constant) or the spec default 1. Iter 113. */
  iconOpacity: PropertyShape<number> | null
  /** Mapbox `icon-color` SDF sprite tint (RGBA 0..1). `null` = no
   *  author input → runtime falls back to LabelDef.iconColor or the
   *  spec default white (#000000-alpha-aware: spec default is
   *  "#000000" but renderer only tints SDF, identity = white).
   *  iter 138. */
  iconColor: PropertyShape<readonly [number, number, number, number]> | null
}

export interface LabelShapes {
  textPaint: TextPaintShapes
  textLayout: TextLayoutShapes
  icon: IconShapes
}
