// ═══ X-GIS Intermediate Representation ═══
// Sits between AST (syntax) and runtime (GPU commands).
// Designed to be extensible for Phase 1 features (zoom interpolation, data-driven, conditionals).

/**
 * A complete IR scene — the output of the lowering pass.
 */
export interface Scene {
  sources: SourceDef[]
  renderNodes: RenderNode[]
  symbols: SymbolDef[]
}

/** A user-defined shape symbol with SVG path data. */
export interface SymbolDef {
  name: string
  paths: string[]
}

/**
 * A data source definition.
 */
export interface SourceDef {
  name: string
  type: string      // 'geojson', 'vector', 'raster', 'raster-dem', 'binary'
  url: string
}

/**
 * A single renderable unit — one layer referencing one source.
 */
export interface RenderNode {
  name: string
  sourceRef: string  // references SourceDef.name
  zOrder: number
  fill: ColorValue
  stroke: StrokeValue
  opacity: OpacityValue
  size: SizeValue
  projection: string
  visible: boolean
  filter: DataExpr | null  // per-feature filter expression (e.g., .pop > 1000000)
  geometry: DataExpr | null  // procedural geometry expression (e.g., circle(.lon, .lat, .r))
  billboard: boolean         // true = faces camera (default), false = flat on ground
  shape: ShapeRef            // point shape (circle default, or named/user-defined)
  /** Billboard anchor: which edge of the quad sits on the projected point.
   *  `center` (default) puts the quad centered on the point; `bottom` makes
   *  the marker stand above the ground like a pin; `top` is its symmetric
   *  counterpart. Only affects billboard (non-flat) point markers. */
  anchor?: 'center' | 'bottom' | 'top'
}

/**
 * Shape reference for point rendering.
 */
export type ShapeRef =
  | { kind: 'none' }                         // circle (analytical default)
  | { kind: 'named'; name: string }          // built-in or user-defined shape
  | { kind: 'data-driven'; expr: DataExpr }  // per-feature shape selection

// ═══ Value types — designed for Phase 1 extension ═══

/**
 * Color can be constant, data-driven, or conditional.
 * Phase 0: only 'constant' is used.
 */
export type ColorValue =
  | { kind: 'constant'; rgba: [number, number, number, number] }
  | { kind: 'none' }
  | { kind: 'data-driven'; expr: DataExpr }
  | { kind: 'conditional'; branches: ConditionalBranch<ColorValue>[]; fallback: ColorValue }

/**
 * Stroke combines color and width.
 */
/** One pattern instance in a stroke's pattern stack (up to 3). */
export interface StrokePattern {
  /** Symbol name — must resolve via ShapeRegistry (built-in or user-defined). */
  shape: string
  /** Repeat spacing. */
  spacing: number
  spacingUnit?: 'm' | 'px' | 'km' | 'nm'
  /** Symbol extent (diameter/width). */
  size: number
  sizeUnit?: 'm' | 'px' | 'km' | 'nm'
  /** Perpendicular offset from the line centerline. */
  offset?: number
  offsetUnit?: 'm' | 'px' | 'km' | 'nm'
  /** Arc offset before the first instance (anchored placements). */
  startOffset?: number
  /** Placement mode: repeat (default), start, end, center. */
  anchor?: 'repeat' | 'start' | 'end' | 'center'
}

export interface StrokeValue {
  color: ColorValue
  width: number
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  /** Dash array in meters (even indices = on, odd = off). */
  dashArray?: number[]
  dashOffset?: number
  /** Up to 3 pattern slots rendered along the line. */
  patterns?: StrokePattern[]
  /** Lateral parallel offset in pixels. Positive = left of travel. */
  offset?: number
  /** Stroke alignment relative to the centerline. Default 'center'.
   *  Inset shifts the stroke onto the left side of travel by half-width
   *  (so the stroke's right edge sits on the original line); outset shifts
   *  the other way. Combined with explicit `offset` by addition. */
  align?: 'center' | 'inset' | 'outset'
}

/**
 * Opacity value. Phase 0: constant only.
 */
export type OpacityValue =
  | { kind: 'constant'; value: number }
  | { kind: 'data-driven'; expr: DataExpr }
  | { kind: 'zoom-interpolated'; stops: ZoomStop<number>[] }

/**
 * Size value for points/symbols.
 */
export type SizeValue =
  | { kind: 'constant'; value: number; unit?: string | null }
  | { kind: 'none' }
  | { kind: 'data-driven'; expr: DataExpr; unit?: string | null }
  | { kind: 'zoom-interpolated'; stops: ZoomStop<number>[] }

/**
 * A zoom stop for interpolated values.
 */
export interface ZoomStop<T> {
  zoom: number
  value: T
}

/**
 * A conditional branch: applies when a data field matches a value.
 */
export interface ConditionalBranch<T> {
  field: string   // the property/modifier name (e.g., "friendly", "hostile")
  value: T        // the value when condition matches
}

/**
 * A reference to an AST expression for per-feature evaluation.
 * Stored as the raw AST Expr node — evaluated at runtime per feature.
 */
export interface DataExpr {
  ast: import('../parser/ast').Expr
  classification?: import('./classify').ExprClass
}

// ═══ Helpers ═══

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

/**
 * Parse hex color string to RGBA tuple (0-1 range).
 */
export function hexToRgba(hex: string): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 1

  if (hex.length === 4) {
    // #RGB
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
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
export function rgbaToHex(rgba: [number, number, number, number]): string {
  const [r, g, b, a] = rgba
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  if (a >= 0.999) {
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`
}
