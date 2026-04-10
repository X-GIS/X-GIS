// ═══ X-GIS Intermediate Representation ═══
// Sits between AST (syntax) and runtime (GPU commands).
// Designed to be extensible for Phase 1 features (zoom interpolation, data-driven, conditionals).

/**
 * A complete IR scene — the output of the lowering pass.
 */
export interface Scene {
  sources: SourceDef[]
  renderNodes: RenderNode[]
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
}

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
export interface StrokeValue {
  color: ColorValue
  width: number
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
  | { kind: 'constant'; value: number }
  | { kind: 'none' }
  | { kind: 'data-driven'; expr: DataExpr }
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

export function sizeConstant(value: number): SizeValue {
  return { kind: 'constant', value }
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
