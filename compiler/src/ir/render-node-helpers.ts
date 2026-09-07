// ═══ X-GIS IR: pure value-type helpers ═══
// Side-effect-free constructors / factories / converters extracted from
// render-node.ts. Each is a pure function — same inputs always produce
// the same output, none close over module state. Kept here so
// render-node.ts stays a focused type-definitions module. The public
// symbols are re-exported from render-node.ts so existing call sites
// (`import { colorConstant } from './render-node'`) keep working.

import type { ColorValue, OpacityValue, SizeValue, ShapeRef } from './render-node'

export function colorNone(): ColorValue {
  return { kind: 'none' }
}

export function colorConstant(r: number, g: number, b: number, a: number = 1): ColorValue {
  return { kind: 'constant', rgba: [r, g, b, a] }
}

export function opacityConstant(value: number): OpacityValue {
  return { kind: 'constant', value }
}

export function sizeNone(): SizeValue {
  return { kind: 'none' }
}

export function sizeConstant(value: number, unit?: string | null): SizeValue {
  return { kind: 'constant', value, unit: unit ?? null }
}

export function shapeNone(): ShapeRef {
  return { kind: 'none' }
}

/** One paint axis's `PropertyShape` under the precedence `buildLabelShapes`
 *  documents below — expression, then zoom stops, then constant, then `null`
 *  for an axis the source omitted. That docblock stays the authority for the
 *  rule; this is the single place it is executed.
 *
 *  Before #2534 the ladder was written out once per property inside
 *  `buildLabelShapes`: eight near-identical copies differing only in which
 *  `input.*` fields they read — the shape `bun run dup:shape` flags and the
 *  token gate cannot, since the field names are the whole difference. */
function pickShape<T>(src: {
  expr?: import('./render-node').DataExpr
  stops?: import('./render-node').ZoomStop<T>[]
  stopsBase?: number
  value?: T
}): import('./property-types').PropertyShape<T> | null {
  if (src.expr) return { kind: 'data-driven', expr: src.expr }
  if (src.stops && src.stops.length > 0) {
    return {
      kind: 'zoom-interpolated',
      stops: src.stops,
      ...(src.stopsBase !== undefined ? { base: src.stopsBase } : {}),
    }
  }
  if (src.value !== undefined) return { kind: 'constant', value: src.value }
  return null
}

/** Build the unified PropertyShape bundle for a label from explicit
 *  inputs. Pure transformation — same inputs always produce the same
 *  shapes. Precedence within each axis matches the runtime resolver
 *  in `map.ts:2710-2800` (the pre-migration source of truth):
 *
 *    data-driven (xxxExpr) > zoom-interpolated (xxxZoomStops) > constant
 *
 *  `size` always returns a non-null PropertyShape because the runtime
 *  needs a numeric font size for every label; the other three return
 *  `null` when the source omitted that axis.
 *
 *  Inputs are passed explicitly (rather than reading off LabelDef)
 *  so the LabelDef type stays clean of `xxxZoomStops` / `xxxExpr`
 *  siblings — those existed only as a staging buffer between
 *  utility-knob parsing in lower.ts and this builder. */
export function buildLabelShapes(input: {
  size: number
  sizeZoomStops?: import('./render-node').ZoomStop<number>[]
  sizeZoomStopsBase?: number
  sizeExpr?: import('./render-node').DataExpr
  color?: [number, number, number, number]
  colorZoomStops?: import('./render-node').ZoomStop<[number, number, number, number]>[]
  colorZoomStopsBase?: number
  colorExpr?: import('./render-node').DataExpr
  halo?: { color: [number, number, number, number]; width: number; blur?: number }
  haloWidthZoomStops?: import('./render-node').ZoomStop<number>[]
  haloWidthZoomStopsBase?: number
  haloColorZoomStops?: import('./render-node').ZoomStop<[number, number, number, number]>[]
  haloColorZoomStopsBase?: number
  /** Font family stack (family names only). Callers that source from
   *  a format which embeds weight / style in family names (e.g. a
   *  trailing "Bold" or "Italic") are responsible for stripping
   *  those into `fontWeight` / `fontStyle` before invoking this
   *  builder. */
  fontStack?: readonly string[]
  fontWeight?: number
  fontStyle?: 'normal' | 'italic'
  iconSize?: number
  iconSizeZoomStops?: import('./render-node').ZoomStop<number>[]
  iconSizeZoomStopsBase?: number
  /** Mapbox `icon-size: case/match/get` — per-feature form (#777 I-F).
   *  Supersedes the constant / zoom-interp inputs when present. */
  iconSizeExpr?: import('./render-node').DataExpr
  /** Mapbox `text-opacity` non-constant forms. Constant is folded
   *  into `color`'s alpha at convert-time (applyAlphaMultiplier).
   *  Iter 113. */
  opacityZoomStops?: import('./render-node').ZoomStop<number>[]
  opacityZoomStopsBase?: number
  opacityExpr?: import('./render-node').DataExpr
  /** Mapbox `icon-opacity`. Constant + non-constant routed through
   *  the same PropertyShape so the runtime resolves per frame. */
  iconOpacity?: number
  iconOpacityZoomStops?: import('./render-node').ZoomStop<number>[]
  iconOpacityZoomStopsBase?: number
  iconOpacityExpr?: import('./render-node').DataExpr
  /** Mapbox `icon-color` — SDF sprite tint. Constant + zoom-interp +
   *  data-driven all route through the same PropertyShape<RGBA> so
   *  the runtime resolves per frame / per feature. iter 138. */
  iconColor?: [number, number, number, number]
  iconColorZoomStops?: import('./render-node').ZoomStop<[number, number, number, number]>[]
  iconColorZoomStopsBase?: number
  iconColorExpr?: import('./render-node').DataExpr
}): import('./property-types').LabelShapes {
  type RGBA = readonly [number, number, number, number]
  type Shape<T> = import('./property-types').PropertyShape<T>

  // `size`'s constant is REQUIRED, so this never falls through; the `??` arm is
  // unreachable and is here only because pickShape's return type cannot say
  // "non-null when `value` is".
  const size: Shape<number> = pickShape({
    expr: input.sizeExpr,
    stops: input.sizeZoomStops,
    stopsBase: input.sizeZoomStopsBase,
    value: input.size,
  }) ?? { kind: 'constant', value: input.size }

  const color: Shape<RGBA> | null = pickShape<RGBA>({
    expr: input.colorExpr,
    stops: input.colorZoomStops,
    stopsBase: input.colorZoomStopsBase,
    value: input.color,
  })

  const haloWidth: Shape<number> | null = pickShape({
    stops: input.haloWidthZoomStops,
    stopsBase: input.haloWidthZoomStopsBase,
    value: input.halo?.width,
  })

  const haloColor: Shape<RGBA> | null = pickShape<RGBA>({
    stops: input.haloColorZoomStops,
    stopsBase: input.haloColorZoomStopsBase,
    value: input.halo?.color,
  })

  const haloBlur: Shape<number> | null =
    input.halo?.blur !== undefined ? { kind: 'constant', value: input.halo.blur } : null

  const font: Shape<readonly string[]> | null =
    input.fontStack && input.fontStack.length > 0
      ? { kind: 'constant', value: input.fontStack }
      : null

  const fontWeight: Shape<number> | null =
    input.fontWeight !== undefined ? { kind: 'constant', value: input.fontWeight } : null

  const fontStyle: Shape<'normal' | 'italic'> | null =
    input.fontStyle !== undefined ? { kind: 'constant', value: input.fontStyle } : null

  // iter 523 — icon-size as PropertyShape so zoom-interp resolves per
  // frame. OFM bright road_oneway authors `interpolate zoom 15→0.5,
  // 19→1`; pre-fix the bracket-binding lower path dropped non-numeric
  // inner values and the runtime fell back to the constant 1, rendering
  // arrows 2× too large at z<=15.
  // `iconSizeExpr` is #777 I-F — applyFeatureExprs evaluates it per feature.
  const iconSize: Shape<number> | null = pickShape({
    expr: input.iconSizeExpr,
    stops: input.iconSizeZoomStops,
    stopsBase: input.iconSizeZoomStopsBase,
    value: input.iconSize,
  })

  // iter 113 — text-opacity as PropertyShape so zoom-interp + data-
  // driven both resolve per frame. Constant is still folded into
  // color.a at convert-time so a simple `text-opacity: 0.6` rides a
  // single label-color-#rrggbbaa utility without round-tripping
  // through this shape. The shape is non-null only when the source
  // authored a non-constant form.
  // Passing no `value` is what implements that: the constant form never
  // reaches this shape.
  const opacity: Shape<number> | null = pickShape({
    expr: input.opacityExpr,
    stops: input.opacityZoomStops,
    stopsBase: input.opacityZoomStopsBase,
  })

  // iter 113 — icon-opacity. Constant ALSO lands here (unlike text-
  // opacity) because there's no equivalent of the label-color-alpha
  // fold for sprite icons — IconRenderer multiplies a per-draw
  // opacity scalar onto the sprite quad's alpha channel.
  const iconOpacity: Shape<number> | null = pickShape({
    expr: input.iconOpacityExpr,
    stops: input.iconOpacityZoomStops,
    stopsBase: input.iconOpacityZoomStopsBase,
    value: input.iconOpacity,
  })

  const iconColor: Shape<RGBA> | null = pickShape<RGBA>({
    expr: input.iconColorExpr,
    stops: input.iconColorZoomStops,
    stopsBase: input.iconColorZoomStopsBase,
    value: input.iconColor,
  })

  return {
    textPaint: { color, haloWidth, haloColor, haloBlur, opacity },
    textLayout: { size, font, fontWeight, fontStyle },
    icon: { iconSize, iconOpacity, iconColor },
  }
}

/**
 * Parse hex color string to RGBA tuple (0-1 range).
 */
export function hexToRgba(hex: string): [number, number, number, number] {
  let r = 0,
    g = 0,
    b = 0,
    a = 1
  // Reject non-hex content before parseInt — mirror of feature-helpers
  // parseHexColor regex gate (caad699). Without it `parseInt('zz',
  // 16)` = NaN propagated through and downstream consumers (shader-gen
  // resolveColorFromAST, fold-trivial-case foldColor) stored NaN
  // tuples.
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
    return [0, 0, 0, 1]
  }

  if (hex.length === 4) {
    // #RGB
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 5) {
    // #RGBA
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
    a = parseInt(hex[4] + hex[4], 16) / 255
  } else if (hex.length === 7) {
    // #RRGGBB
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    // #RRGGBBAA
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }

  return [r, g, b, a]
}

/**
 * Convert RGBA tuple (0-1) to hex string.
 */
export function rgbaToHex(rgba: import('./property-types').RGBA): string {
  const [r, g, b, a] = rgba
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  if (a >= 0.999) {
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`
}
