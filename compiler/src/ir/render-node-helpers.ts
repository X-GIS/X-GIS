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

  let size: Shape<number>
  if (input.sizeExpr) {
    size = { kind: 'data-driven', expr: input.sizeExpr }
  } else if (input.sizeZoomStops && input.sizeZoomStops.length > 0) {
    size = {
      kind: 'zoom-interpolated',
      stops: input.sizeZoomStops,
      ...(input.sizeZoomStopsBase !== undefined ? { base: input.sizeZoomStopsBase } : {}),
    }
  } else {
    size = { kind: 'constant', value: input.size }
  }

  let color: Shape<RGBA> | null = null
  if (input.colorExpr) {
    color = { kind: 'data-driven', expr: input.colorExpr }
  } else if (input.colorZoomStops && input.colorZoomStops.length > 0) {
    color = {
      kind: 'zoom-interpolated',
      stops: input.colorZoomStops,
      ...(input.colorZoomStopsBase !== undefined ? { base: input.colorZoomStopsBase } : {}),
    }
  } else if (input.color) {
    color = { kind: 'constant', value: input.color }
  }

  let haloWidth: Shape<number> | null = null
  if (input.haloWidthZoomStops && input.haloWidthZoomStops.length > 0) {
    haloWidth = {
      kind: 'zoom-interpolated',
      stops: input.haloWidthZoomStops,
      ...(input.haloWidthZoomStopsBase !== undefined ? { base: input.haloWidthZoomStopsBase } : {}),
    }
  } else if (input.halo?.width !== undefined) {
    haloWidth = { kind: 'constant', value: input.halo.width }
  }

  let haloColor: Shape<RGBA> | null = null
  if (input.haloColorZoomStops && input.haloColorZoomStops.length > 0) {
    haloColor = {
      kind: 'zoom-interpolated',
      stops: input.haloColorZoomStops,
      ...(input.haloColorZoomStopsBase !== undefined ? { base: input.haloColorZoomStopsBase } : {}),
    }
  } else if (input.halo?.color) {
    haloColor = { kind: 'constant', value: input.halo.color }
  }

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
  let iconSize: Shape<number> | null = null
  if (input.iconSizeZoomStops && input.iconSizeZoomStops.length > 0) {
    iconSize = {
      kind: 'zoom-interpolated',
      stops: input.iconSizeZoomStops,
      ...(input.iconSizeZoomStopsBase !== undefined ? { base: input.iconSizeZoomStopsBase } : {}),
    }
  } else if (input.iconSize !== undefined) {
    iconSize = { kind: 'constant', value: input.iconSize }
  }

  // iter 113 — text-opacity as PropertyShape so zoom-interp + data-
  // driven both resolve per frame. Constant is still folded into
  // color.a at convert-time so a simple `text-opacity: 0.6` rides a
  // single label-color-#rrggbbaa utility without round-tripping
  // through this shape. The shape is non-null only when the source
  // authored a non-constant form.
  let opacity: Shape<number> | null = null
  if (input.opacityExpr) {
    opacity = { kind: 'data-driven', expr: input.opacityExpr }
  } else if (input.opacityZoomStops && input.opacityZoomStops.length > 0) {
    opacity = {
      kind: 'zoom-interpolated',
      stops: input.opacityZoomStops,
      ...(input.opacityZoomStopsBase !== undefined ? { base: input.opacityZoomStopsBase } : {}),
    }
  }

  // iter 113 — icon-opacity. Constant ALSO lands here (unlike text-
  // opacity) because there's no equivalent of the label-color-alpha
  // fold for sprite icons — IconRenderer multiplies a per-draw
  // opacity scalar onto the sprite quad's alpha channel.
  let iconOpacity: Shape<number> | null = null
  if (input.iconOpacityExpr) {
    iconOpacity = { kind: 'data-driven', expr: input.iconOpacityExpr }
  } else if (input.iconOpacityZoomStops && input.iconOpacityZoomStops.length > 0) {
    iconOpacity = {
      kind: 'zoom-interpolated',
      stops: input.iconOpacityZoomStops,
      ...(input.iconOpacityZoomStopsBase !== undefined
        ? { base: input.iconOpacityZoomStopsBase }
        : {}),
    }
  } else if (input.iconOpacity !== undefined) {
    iconOpacity = { kind: 'constant', value: input.iconOpacity }
  }

  let iconColor: Shape<RGBA> | null = null
  if (input.iconColorExpr) {
    iconColor = { kind: 'data-driven', expr: input.iconColorExpr }
  } else if (input.iconColorZoomStops && input.iconColorZoomStops.length > 0) {
    iconColor = {
      kind: 'zoom-interpolated',
      stops: input.iconColorZoomStops,
      ...(input.iconColorZoomStopsBase !== undefined ? { base: input.iconColorZoomStopsBase } : {}),
    }
  } else if (input.iconColor) {
    iconColor = { kind: 'constant', value: input.iconColor }
  }

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
