// ═══ Point-derived instanced-paint emit (Phase R heatmap, #1302 arrow) ═══
// Emit helpers for paints that instance one GPU primitive per GeoJSON Point
// feature and are routed by an `isXxx` marker to a dedicated runtime renderer
// (heatmap splats → HeatmapRenderer, arrow glyphs → ArrowRenderer). Split out
// of emit-commands.ts to keep it under the 800-LOC non-baselined god-file cap.

import type { RenderNode, DataExpr } from './render-node'

/** Heatmap paint axes (Mapbox `heatmap-*`, Phase R). */
export interface HeatmapPaint {
  /** True when the layer is a Mapbox `heatmap` layer (the `heatmap` marker
   *  utility). Routes the runtime to the HeatmapRenderer. */
  isHeatmap?: boolean
  /** heatmap-radius — Gaussian splat radius in CSS px. Default 30. */
  heatmapRadius?: number
  /** heatmap-weight — per-feature contribution multiplier. Default 1. */
  heatmapWeight?: number
  /** heatmap-intensity — overall density scale. Default 1. */
  heatmapIntensity?: number
  /** heatmap-opacity — layer alpha 0..1. Default 1. */
  heatmapOpacity?: number
  /** heatmap-color ramp stops (offset 0..1 over heatmap-density → RGBA). */
  heatmapColorStops?: { offset: number; rgba: [number, number, number, number] }[]
}

/** Heatmap paint fields (Phase R). */
export function emitHeatmapFields(node: RenderNode): HeatmapPaint {
  return {
    isHeatmap: node.isHeatmap,
    heatmapRadius: node.heatmapRadius,
    heatmapWeight: node.heatmapWeight,
    heatmapIntensity: node.heatmapIntensity,
    heatmapOpacity: node.heatmapOpacity,
    heatmapColorStops: node.heatmapColorStops,
  }
}

/** Arrow-layer axes (#1302). Present on a layer marked with the `arrow`
 *  utility; `isArrow` routes the runtime rebuildLayers fork to the compiled
 *  ArrowRenderer. The per-feature bearing is a resolved-value pair like
 *  size/sizeExpr (constant vs data-driven). */
export interface ArrowPaint {
  /** True when the layer is an `arrow` layer. Routes to the ArrowRenderer. */
  isArrow?: boolean
  /** Constant per-layer bearing (degrees true, 0 = N clockwise); null when data-driven. */
  arrowBearing?: number | null
  /** Per-feature bearing expression (`bearing-[.dir]`); null when constant. */
  arrowBearingExpr?: DataExpr | null
}

/** Arrow-layer axes (#1302) — mirrors emitHeatmapFields. The per-feature bearing
 *  (a SizeValue on the node) splits into a constant + a data-driven expr,
 *  exactly like size / sizeExpr, so the runtime evaluates it per feature. */
export function emitArrowFields(node: RenderNode): ArrowPaint {
  return {
    isArrow: node.isArrow,
    arrowBearing: node.arrowBearing?.kind === 'constant' ? node.arrowBearing.value : null,
    arrowBearingExpr: node.arrowBearing?.kind === 'data-driven' ? node.arrowBearing.expr : null,
  }
}
