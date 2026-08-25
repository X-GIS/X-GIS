// ═══ AST → IR Lowering: LABEL knob FOLD ═══
// Leaf half of the `label-*` lowering sub-pass: `lowerLabelProps`
// (lower-label.ts) accumulates one local per knob while walking the utility
// items; `foldLabelKnobs` is the pure assembly step that merges those
// accumulated values onto the LabelDef built from `label-[<expr>]`. Extracted
// VERBATIM from lower-label.ts (#2051, design doc §9): that file sat at its
// 1190-line ceiling with zero headroom, and the T4 CJK track adds a knob per
// phase — "extract, never bump".
//
// SEAM: one call site (`lowerLabelProps`'s single `return foldLabelKnobs(...)`),
// no shared mutable state, no back-edge. A new label knob touches BOTH halves —
// the accumulator + loop arm stay in lower-label.ts, the `knobs` field + the
// merged spread come here.

import { type ZoomStop, buildLabelShapes } from './render-node'

/** Merge sibling `label-*` utility values into the LabelDef built
 *  from `label-[<expr>]`. Returns the input unchanged when no knobs
 *  are present (covers the common one-utility-only case). When knobs
 *  exist but the layer has no `label-[<expr>]`, returns undefined —
 *  visual knobs without a text source produce no rendering and the
 *  warning is the user's responsibility (the converter surfaces it). */
export function foldLabelKnobs(
  base: import('./render-node').LabelDef | undefined,
  knobs: {
    labelSize?: number
    labelColor?: [number, number, number, number]
    labelHaloWidth?: number
    labelHaloColor?: [number, number, number, number]
    labelHaloBlur?: number
    labelAnchor?: import('./render-node').LabelDef['anchor']
    labelAnchorCandidates?: import('./render-node').LabelDef['anchorCandidates']
    labelTransform?: import('./render-node').LabelDef['transform']
    labelOffsetX?: number
    labelOffsetY?: number
    labelTranslateX?: number
    labelTranslateY?: number
    labelTranslateAnchorMap?: boolean
    labelRadialOffset?: number
    labelVariableAnchorOffset?: import('./render-node').LabelDef['variableAnchorOffset']
    labelSizeZoomStops?: ZoomStop<number>[]
    /** Mapbox `["exponential", N]` curve base for the size stops.
     *  Undefined / 1 → linear; >1 → faster growth at higher zooms. */
    labelSizeZoomStopsBase?: number
    labelColorZoomStops?: ZoomStop<[number, number, number, number]>[]
    labelColorZoomStopsBase?: number
    labelColorExpr?: import('./render-node').DataExpr
    labelSizeExpr?: import('./render-node').DataExpr
    labelHaloWidthZoomStops?: ZoomStop<number>[]
    labelHaloWidthZoomStopsBase?: number
    labelHaloColorZoomStops?: ZoomStop<[number, number, number, number]>[]
    labelHaloColorZoomStopsBase?: number
    labelAllowOverlap?: boolean
    labelIgnorePlacement?: boolean
    labelPadding?: number
    labelSortKey?: number
    labelRotate?: number
    labelLetterSpacing?: number
    labelFontStack?: string[]
    labelFontWeight?: number
    labelFontStyle?: 'normal' | 'italic'
    labelMaxWidth?: number
    labelLineHeight?: number
    labelJustify?: 'auto' | 'left' | 'center' | 'right'
    labelPlacement?: 'point' | 'line' | 'line-center'
    labelSpacing?: number
    labelRotationAlignment?: 'map' | 'viewport' | 'auto'
    labelPitchAlignment?: 'map' | 'viewport' | 'auto'
    labelKeepUpright?: boolean
    labelMaxAngle?: number
    labelWritingMode?: 'vertical'
    labelSymbolZOrder?: 'auto' | 'viewport-y' | 'source'
    labelIconImage?: string
    labelIconImageExpr?: { ast: unknown }
    labelIconSize?: number
    labelIconSizeZoomStops?: ZoomStop<number>[]
    labelIconSizeZoomStopsBase?: number
    labelIconSizeExpr?: { ast: unknown }
    labelIconAnchor?: import('./render-node').LabelDef['iconAnchor']
    labelIconOffset?: [number, number]
    labelIconTranslateX?: number
    labelIconTranslateY?: number
    labelIconTranslateExpr?: { ast: unknown }
    labelIconTranslateAnchorMap?: boolean
    labelIconRotate?: number
    labelIconOpacity?: number
    labelIconRotationAlignment?: 'map'
    labelIconCollide?: boolean
    labelIconIgnorePlacement?: boolean
    labelIconOptional?: boolean
    labelIconPadding?: number
    labelIconKeepUpright?: boolean
    labelIconTextFit?: 'width' | 'height' | 'both'
    labelIconTextFitPadding?: [number, number, number, number]
    // iter 113 — opacity PropertyShape inputs (zoom-interp + expr).
    labelOpacityZoomStops?: ZoomStop<number>[]
    labelOpacityZoomStopsBase?: number
    labelOpacityExpr?: { ast: unknown }
    labelIconOpacityZoomStops?: ZoomStop<number>[]
    labelIconOpacityZoomStopsBase?: number
    labelIconOpacityExpr?: { ast: unknown }
    // iter 138 — icon-color (SDF tint) PropertyShape inputs.
    labelIconColor?: [number, number, number, number]
    labelIconColorZoomStops?: ZoomStop<[number, number, number, number]>[]
    labelIconColorZoomStopsBase?: number
    labelIconColorExpr?: import('./render-node').DataExpr
  },
): import('./render-node').LabelDef | undefined {
  if (!base) return undefined
  let halo = base.halo
  if (
    knobs.labelHaloWidth !== undefined ||
    knobs.labelHaloColor !== undefined ||
    knobs.labelHaloBlur !== undefined
  ) {
    const resolvedBlur = knobs.labelHaloBlur ?? base.halo?.blur
    halo = {
      // Mapbox `text-halo-color` default is transparent black (no visible
      // halo); `text-halo-width` default is 0 (shader gates on > 0).
      color: knobs.labelHaloColor ?? base.halo?.color ?? [0, 0, 0, 0],
      width: knobs.labelHaloWidth ?? base.halo?.width ?? 0,
      ...(resolvedBlur !== undefined ? { blur: resolvedBlur } : {}),
    }
  }
  let offset = base.offset
  if (knobs.labelOffsetX !== undefined || knobs.labelOffsetY !== undefined) {
    offset = [
      knobs.labelOffsetX ?? base.offset?.[0] ?? 0,
      knobs.labelOffsetY ?? base.offset?.[1] ?? 0,
    ]
  }
  let translate = base.translate
  if (knobs.labelTranslateX !== undefined || knobs.labelTranslateY !== undefined) {
    translate = [
      knobs.labelTranslateX ?? base.translate?.[0] ?? 0,
      knobs.labelTranslateY ?? base.translate?.[1] ?? 0,
    ]
  }
  const merged: import('./render-node').LabelDef = {
    ...base,
    ...(knobs.labelSize !== undefined ? { size: knobs.labelSize } : {}),
    ...(knobs.labelColor !== undefined ? { color: knobs.labelColor } : {}),
    ...(halo !== undefined ? { halo } : {}),
    ...(knobs.labelAnchor !== undefined ? { anchor: knobs.labelAnchor } : {}),
    ...(knobs.labelAnchorCandidates !== undefined
      ? { anchorCandidates: knobs.labelAnchorCandidates }
      : {}),
    ...(knobs.labelTransform !== undefined ? { transform: knobs.labelTransform } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(translate !== undefined ? { translate } : {}),
    ...(knobs.labelTranslateAnchorMap !== undefined
      ? { translateAnchorMap: knobs.labelTranslateAnchorMap }
      : {}),
    ...(knobs.labelRadialOffset !== undefined ? { radialOffset: knobs.labelRadialOffset } : {}),
    ...(knobs.labelVariableAnchorOffset !== undefined && knobs.labelVariableAnchorOffset.length > 0
      ? { variableAnchorOffset: knobs.labelVariableAnchorOffset }
      : {}),
    ...(knobs.labelAllowOverlap !== undefined ? { allowOverlap: knobs.labelAllowOverlap } : {}),
    ...(knobs.labelIgnorePlacement !== undefined
      ? { ignorePlacement: knobs.labelIgnorePlacement }
      : {}),
    ...(knobs.labelPadding !== undefined ? { padding: knobs.labelPadding } : {}),
    ...(knobs.labelSortKey !== undefined ? { sortKey: knobs.labelSortKey } : {}),
    ...(knobs.labelRotate !== undefined ? { rotate: knobs.labelRotate } : {}),
    ...(knobs.labelLetterSpacing !== undefined ? { letterSpacing: knobs.labelLetterSpacing } : {}),
    ...(knobs.labelFontStack !== undefined && knobs.labelFontStack.length > 0
      ? { font: knobs.labelFontStack }
      : {}),
    ...(knobs.labelFontWeight !== undefined ? { fontWeight: knobs.labelFontWeight } : {}),
    ...(knobs.labelFontStyle !== undefined ? { fontStyle: knobs.labelFontStyle } : {}),
    ...(knobs.labelMaxWidth !== undefined ? { maxWidth: knobs.labelMaxWidth } : {}),
    ...(knobs.labelLineHeight !== undefined ? { lineHeight: knobs.labelLineHeight } : {}),
    ...(knobs.labelJustify !== undefined ? { justify: knobs.labelJustify } : {}),
    ...(knobs.labelPlacement !== undefined ? { placement: knobs.labelPlacement } : {}),
    ...(knobs.labelSpacing !== undefined ? { spacing: knobs.labelSpacing } : {}),
    ...(knobs.labelRotationAlignment !== undefined
      ? { rotationAlignment: knobs.labelRotationAlignment }
      : {}),
    ...(knobs.labelPitchAlignment !== undefined
      ? { pitchAlignment: knobs.labelPitchAlignment }
      : {}),
    ...(knobs.labelKeepUpright !== undefined ? { keepUpright: knobs.labelKeepUpright } : {}),
    ...(knobs.labelMaxAngle !== undefined ? { maxAngle: knobs.labelMaxAngle } : {}),
    ...(knobs.labelWritingMode !== undefined ? { writingMode: knobs.labelWritingMode } : {}),
    ...(knobs.labelSymbolZOrder !== undefined ? { symbolZOrder: knobs.labelSymbolZOrder } : {}),
    // Batch 2 — sprite icon fields
    ...(knobs.labelIconImage !== undefined ? { iconImage: knobs.labelIconImage } : {}),
    ...(knobs.labelIconImageExpr !== undefined ? { iconImageExpr: knobs.labelIconImageExpr } : {}),
    ...(knobs.labelIconSize !== undefined ? { iconSize: knobs.labelIconSize } : {}),
    ...(knobs.labelIconAnchor !== undefined ? { iconAnchor: knobs.labelIconAnchor } : {}),
    ...(knobs.labelIconOffset !== undefined ? { iconOffset: knobs.labelIconOffset } : {}),
    ...(knobs.labelIconTranslateX !== undefined
      ? { iconTranslateX: knobs.labelIconTranslateX }
      : {}),
    ...(knobs.labelIconTranslateY !== undefined
      ? { iconTranslateY: knobs.labelIconTranslateY }
      : {}),
    ...(knobs.labelIconTranslateExpr !== undefined
      ? { iconTranslateExpr: knobs.labelIconTranslateExpr }
      : {}),
    ...(knobs.labelIconTranslateAnchorMap !== undefined
      ? { iconTranslateAnchorMap: knobs.labelIconTranslateAnchorMap }
      : {}),
    ...(knobs.labelIconRotate !== undefined ? { iconRotate: knobs.labelIconRotate } : {}),
    ...(knobs.labelIconOpacity !== undefined ? { iconOpacity: knobs.labelIconOpacity } : {}),
    ...(knobs.labelIconColor !== undefined ? { iconColor: knobs.labelIconColor } : {}),
    ...(knobs.labelIconRotationAlignment !== undefined
      ? { iconRotationAlignment: knobs.labelIconRotationAlignment }
      : {}),
    ...(knobs.labelIconCollide !== undefined ? { iconCollide: knobs.labelIconCollide } : {}),
    ...(knobs.labelIconIgnorePlacement !== undefined
      ? { iconIgnorePlacement: knobs.labelIconIgnorePlacement }
      : {}),
    ...(knobs.labelIconOptional !== undefined ? { iconOptional: knobs.labelIconOptional } : {}),
    ...(knobs.labelIconPadding !== undefined ? { iconPadding: knobs.labelIconPadding } : {}),
    ...(knobs.labelIconKeepUpright !== undefined
      ? { iconKeepUpright: knobs.labelIconKeepUpright }
      : {}),
    ...(knobs.labelIconTextFit !== undefined ? { iconTextFit: knobs.labelIconTextFit } : {}),
    ...(knobs.labelIconTextFitPadding !== undefined
      ? { iconTextFitPadding: knobs.labelIconTextFitPadding }
      : {}),
  }
  // Plan Label L3: build the unified shapes bundle from the knob inputs
  // + the merged label's static fallbacks.
  merged.shapes = buildLabelShapes({
    size: merged.size,
    sizeZoomStops:
      knobs.labelSizeZoomStops && knobs.labelSizeZoomStops.length > 0
        ? knobs.labelSizeZoomStops
        : undefined,
    sizeZoomStopsBase: knobs.labelSizeZoomStopsBase,
    sizeExpr: knobs.labelSizeExpr,
    color: merged.color,
    colorZoomStops:
      knobs.labelColorZoomStops && knobs.labelColorZoomStops.length > 0
        ? knobs.labelColorZoomStops
        : undefined,
    colorZoomStopsBase: knobs.labelColorZoomStopsBase,
    colorExpr: knobs.labelColorExpr,
    halo: merged.halo,
    haloWidthZoomStops:
      knobs.labelHaloWidthZoomStops && knobs.labelHaloWidthZoomStops.length > 0
        ? knobs.labelHaloWidthZoomStops
        : undefined,
    haloWidthZoomStopsBase: knobs.labelHaloWidthZoomStopsBase,
    haloColorZoomStops:
      knobs.labelHaloColorZoomStops && knobs.labelHaloColorZoomStops.length > 0
        ? knobs.labelHaloColorZoomStops
        : undefined,
    haloColorZoomStopsBase: knobs.labelHaloColorZoomStopsBase,
    fontStack: merged.font,
    fontWeight: merged.fontWeight,
    fontStyle: merged.fontStyle,
    iconSize: merged.iconSize,
    iconSizeZoomStops:
      knobs.labelIconSizeZoomStops && knobs.labelIconSizeZoomStops.length > 0
        ? knobs.labelIconSizeZoomStops
        : undefined,
    iconSizeZoomStopsBase: knobs.labelIconSizeZoomStopsBase,
    iconSizeExpr: knobs.labelIconSizeExpr as import('./render-node').DataExpr | undefined,
    opacityZoomStops:
      knobs.labelOpacityZoomStops && knobs.labelOpacityZoomStops.length > 0
        ? knobs.labelOpacityZoomStops
        : undefined,
    opacityZoomStopsBase: knobs.labelOpacityZoomStopsBase,
    opacityExpr: knobs.labelOpacityExpr as import('./render-node').DataExpr | undefined,
    iconOpacity: merged.iconOpacity,
    iconOpacityZoomStops:
      knobs.labelIconOpacityZoomStops && knobs.labelIconOpacityZoomStops.length > 0
        ? knobs.labelIconOpacityZoomStops
        : undefined,
    iconOpacityZoomStopsBase: knobs.labelIconOpacityZoomStopsBase,
    iconOpacityExpr: knobs.labelIconOpacityExpr as import('./render-node').DataExpr | undefined,
    iconColor: merged.iconColor,
    iconColorZoomStops:
      knobs.labelIconColorZoomStops && knobs.labelIconColorZoomStops.length > 0
        ? knobs.labelIconColorZoomStops
        : undefined,
    iconColorZoomStopsBase: knobs.labelIconColorZoomStopsBase,
    iconColorExpr: knobs.labelIconColorExpr,
  })
  return merged
}
