// ═══ AST → IR Lowering: per-binding handler registry ═══
// The `lowerLayer` (lower.ts) utility loop used to be a single hand-written
// if/else ladder: every paint property was an `else if (name === 'X')` arm,
// a `let` in the function-body accumulator, and a key in the return literal.
// Adding one property meant a lock-step edit across all three.
//
// This module turns that ladder into a descriptor REGISTRY over a shared
// mutable LayerAccumulator. Each arm becomes a `BindingHandler` — a matcher
// predicate + an `apply(ctx)` that mutates the accumulator exactly as the
// original arm did. The handlers are grouped by concern into sibling modules
// (lower-bindings-fill / -line / -paint) and assembled here into ONE ordered
// list per item-class. The driver walks the list FIRST-MATCH-WINS, reproducing
// the original `else if` cascade byte-for-byte (the order IS the contract —
// e.g. `fill-pattern-*` precedes the generic `fill-*` color arm).
//
// FAITHFULNESS INVARIANT (lower.ts decomposition): this is a pure RELOCATION
// of the arm bodies — no algorithm changes. Cascade order (named style →
// inline CSS → utilities; and within utilities the exact ladder order) and the
// X-GIS0005 catch-all are preserved. Guarded by ir.test.ts + the IR snapshot
// gates (byte-identical IR over the demo/OFM corpus).

import type * as AST from '../parser/ast'
import type {
  ColorValue,
  SizeValue,
  OpacityValue,
  ZoomStop,
  Easing,
  ConditionalBranch,
  Diagnostic,
  ExtrudeValue,
  DataExpr,
  StrokePattern,
  ShapeRef,
} from './render-node'
import type { LowerOptions } from './lower-types'

/** Inline per-axis zoom-interp scalar shape (structurally a
 *  ZoomStop<number>[]). Kept local so the binding modules don't pull a
 *  ZoomStop import just for the translate/opacity shapes — mirrors the
 *  `TranslateShape` local that lived in lower.ts. */
export type TranslateShape = {
  kind: 'zoom-interpolated'
  stops: { zoom: number; value: number }[]
  base?: number
}

/** Mutable accumulator threaded through every BindingHandler. One field per
 *  `let`/`const` the original `lowerLayer` loop body declared. The driver
 *  seeds it (with the post-style-cascade values), the handlers mutate it, and
 *  lowerLayer reads it back to build the RenderNode return literal. */
export interface LayerAccumulator {
  fill: ColorValue
  extrude: ExtrudeValue
  extrudeBase: ExtrudeValue
  fillPattern: string | null
  linePattern: string | null
  fillTranslateX: number | undefined
  fillTranslateY: number | undefined
  fillAntialias: boolean | undefined
  fillExtrusionVerticalGradient: boolean | undefined
  circleTranslateX: number | undefined
  circleTranslateY: number | undefined
  circleBlur: number | undefined
  circlePitchScaleMap: boolean | undefined
  strokeTranslateX: number | undefined
  strokeTranslateY: number | undefined
  fillTranslateAnchorMap: boolean | undefined
  strokeTranslateAnchorMap: boolean | undefined
  fillTranslateXShape: TranslateShape | undefined
  fillTranslateYShape: TranslateShape | undefined
  circleTranslateXShape: TranslateShape | undefined
  circleTranslateYShape: TranslateShape | undefined
  strokeTranslateXShape: TranslateShape | undefined
  strokeTranslateYShape: TranslateShape | undefined
  strokeColor: ColorValue
  strokeWidth: number
  strokeWidthExpr: DataExpr | undefined
  strokeColorExpr: DataExpr | undefined
  strokeWidthZoomStops: ZoomStop<number>[] | undefined
  strokeWidthZoomStopsBase: number | undefined
  linecap: 'butt' | 'round' | 'square' | 'arrow' | undefined
  linejoin: 'miter' | 'round' | 'bevel' | undefined
  miterlimit: number | undefined
  roundLimit: number | undefined
  dashArray: number[] | undefined
  dashOffset: number | undefined
  strokeOffset: number | undefined
  strokeAlign: 'center' | 'inset' | 'outset' | undefined
  strokeBlur: number | undefined
  dashArrayShape:
    | { kind: 'zoom-interpolated'; stops: { zoom: number; value: number[] }[]; base?: number }
    | undefined
  strokeOpacityShape:
    | { kind: 'zoom-interpolated'; stops: { zoom: number; value: number }[]; base?: number }
    | undefined
  strokeGapWidth: number | undefined
  patternSlots: StrokePattern[]
  patternDirty: boolean[]
  parsePatternAttr: (rest: string, slotIdx: number) => void
  opacity: OpacityValue
  size: SizeValue
  projection: string
  visible: boolean
  pointerEvents: 'auto' | 'none'
  billboard: boolean
  anchor: 'center' | 'bottom' | 'top' | undefined
  shape: ShapeRef
  fillBranches: ConditionalBranch<ColorValue>[]
  opacityZoomStops: ZoomStop<number>[]
  sizeZoomStops: ZoomStop<number>[]
  opacityZoomStopsBase: number | undefined
  sizeZoomStopsBase: number | undefined
  animationName: string | null
  animationDurationMs: number
  animationEasing: Easing
  animationDelayMs: number
  animationLoop: boolean
  rasterHueRotate: number | undefined
  rasterBrightnessMin: number | undefined
  rasterBrightnessMax: number | undefined
  rasterSaturation: number | undefined
  rasterContrast: number | undefined
  rasterResamplingNearest: boolean | undefined
  // Hillshade DEM-relief paint axes (#777 Phase II). All undefined = layer
  // didn't author the axis → renderer falls back to the spec default (no-op).
  hillshadeDirection: number | undefined
  hillshadeAltitude: number | undefined
  hillshadeAnchorMap: boolean | undefined
  hillshadeExaggeration: number | undefined
  hillshadeShadow: [number, number, number, number] | undefined
  hillshadeHighlight: [number, number, number, number] | undefined
  hillshadeAccent: [number, number, number, number] | undefined
  hillshadeMethod: import('./property-types').HillshadeMethod | undefined
  hillshadeResamplingNearest: boolean | undefined
  /** Multidirectional sources 2..4, sparse per-axis (index 0 = source 2). */
  hillshadeExtraSources:
    | {
        direction?: number
        altitude?: number
        shadow?: [number, number, number, number]
        highlight?: [number, number, number, number]
      }[]
    | undefined
  // Arrow layer (#1302). `isArrow` is the marker the `arrow` utility sets;
  // `arrowBearing` carries the per-feature rotation (bearing-[.dir] / bearing-N).
  isArrow: boolean | undefined
  arrowBearing: SizeValue | undefined
  // Heatmap paint axes (Phase R). isHeatmap is the marker the converter's
  // `heatmap` utility sets; the rest carry the resolved scalars + ramp.
  isHeatmap: boolean | undefined
  heatmapRadius: number | undefined
  heatmapWeight: number | undefined
  heatmapIntensity: number | undefined
  heatmapOpacity: number | undefined
  heatmapColorStops: { offset: number; rgba: [number, number, number, number] }[] | undefined
}

/** Per-item lowering context handed to each BindingHandler. Bundles the
 *  current utility item + the shared sinks the original arms closed over. */
export interface BindingCtx {
  name: string
  mod: string | null | undefined
  item: AST.UtilityItem
  stmt: AST.LayerStatement
  diagnostics: Diagnostic[]
  options: LowerOptions
  acc: LayerAccumulator
}

/** A relocated arm: `match` reproduces the original `if`/`else if` guard;
 *  `apply` runs the arm body against the accumulator. `apply` returns `true`
 *  when the arm fully consumed the item (the original `continue`), so the
 *  driver can stop — matching the original control flow. A handler whose
 *  `match` is true but whose body chose not to consume (the original arms that
 *  fell through without `continue`) returns `false`. */
export interface BindingHandler {
  match: (ctx: BindingCtx) => boolean
  /** @returns true if the item is fully handled (original `continue`). */
  apply: (ctx: BindingCtx) => boolean
}

/**
 * Walk an ordered handler list reproducing the original if/else-if ladder.
 *
 * Two original control-flow shapes must be preserved:
 *  - A guarded zoom-binding arm like `if (zoomStops && name === 'X') { …;
 *    continue }`: when the guard's INNER condition fails (no zoomStops) the
 *    original code fell THROUGH to the later named ladder. So a handler whose
 *    `match` is true but whose `apply` returns FALSE (not consumed) must NOT
 *    stop the scan — we keep walking, exactly like the fall-through.
 *  - An unconditional arm like `else if (name === 'X') { … }`: `apply` returns
 *    true and the scan stops (the original `continue`, or the end of the
 *    else-if chain for a matched terminal arm).
 *
 * @returns 'handled' (some arm consumed the item) or 'none' (fell through every
 *   handler → the driver runs the X-GIS0005 / further fallbacks).
 */
export function dispatch(handlers: BindingHandler[], ctx: BindingCtx): 'handled' | 'none' {
  for (const h of handlers) {
    if (h.match(ctx) && h.apply(ctx)) return 'handled'
  }
  return 'none'
}
