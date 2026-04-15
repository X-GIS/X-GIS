// ═══ IR → SceneCommands Bridge ═══
// Converts IR Scene to the existing runtime SceneCommands format.
// This bridge allows the runtime to consume IR without changes.

import type { Scene, RenderNode, ColorValue, ZoomStop, TimeStop, Easing, DataExpr } from './render-node'
import { rgbaToHex } from './render-node'
import { generateShaderVariant, type ShaderVariant } from '../codegen/shader-gen'

export type { ShaderVariant } from '../codegen/shader-gen'

export interface LoadCommand {
  name: string
  url: string
}

export interface ShowCommand {
  targetName: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  projection: string
  visible: boolean
  opacity: number
  size: number | null
  zoomOpacityStops: ZoomStop<number>[] | null
  zoomSizeStops: ZoomStop<number>[] | null
  shaderVariant: ShaderVariant | null
  filterExpr: DataExpr | null
  geometryExpr: DataExpr | null
  sizeUnit: string | null
  sizeExpr: DataExpr | null
  billboard: boolean
  anchor?: 'center' | 'bottom' | 'top'
  shape: string | null
  shapeDefs: { name: string; paths: string[] }[]
  // Phase 2: line styling
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  // Phase 3: dash array
  dashArray?: number[]
  dashOffset?: number
  // Phase 4: pattern stack (up to 3 slots)
  patterns?: import('./render-node').StrokePattern[]
  /** Lateral parallel offset in pixels (positive = left of travel). */
  strokeOffset?: number
  /** Stroke alignment — 'inset' / 'outset' shift by ±half_width at runtime. */
  strokeAlign?: 'center' | 'inset' | 'outset'
  // ── Animation ──
  //
  // PR 1 shipped time*Opacity; PR 3 adds time* stops for fill/stroke
  // color, stroke width, point size, and dash offset. All share the
  // same loop/easing/delay metadata because a single layer only hosts
  // one animation reference (`animation-<name>`) at a time.
  timeOpacityStops: TimeStop<number>[] | null
  timeFillStops: TimeStop<[number, number, number, number]>[] | null
  timeStrokeStops: TimeStop<[number, number, number, number]>[] | null
  timeStrokeWidthStops: TimeStop<number>[] | null
  timeSizeStops: TimeStop<number>[] | null
  timeDashOffsetStops: TimeStop<number>[] | null
  timeOpacityLoop: boolean
  timeOpacityEasing: Easing
  timeOpacityDelayMs: number
}

export interface SceneCommands {
  loads: LoadCommand[]
  shows: ShowCommand[]
  symbols: { name: string; paths: string[] }[]
}

/**
 * Convert an IR Scene to the legacy SceneCommands format
 * that the existing runtime expects.
 */
export function emitCommands(scene: Scene): SceneCommands {
  const loads: LoadCommand[] = scene.sources.map(src => ({
    name: src.name,
    url: src.url,
  }))

  const shows: ShowCommand[] = scene.renderNodes.map(emitShow)

  return { loads, shows, symbols: scene.symbols }
}

function emitShow(node: RenderNode): ShowCommand {
  // Generate shader variant for this layer
  const shaderVariant = generateShaderVariant(node)

  // Project opacity through the three shapes: constant / zoom / time / hybrid.
  // The zoom-time hybrid populates BOTH zoomOpacityStops and timeOpacityStops;
  // the runtime composes them multiplicatively so zoom-opacity acts as a
  // slow envelope around the faster animation pulse.
  const op = node.opacity
  const zoomOpacityStops: ZoomStop<number>[] | null =
    op.kind === 'zoom-interpolated' ? op.stops :
    op.kind === 'zoom-time' ? op.zoomStops :
    null
  const timeOpacityStops: TimeStop<number>[] | null =
    op.kind === 'time-interpolated' ? op.stops :
    op.kind === 'zoom-time' ? op.timeStops :
    null
  const timeOpacityLoop =
    op.kind === 'time-interpolated' || op.kind === 'zoom-time' ? op.loop : false
  const timeOpacityEasing: Easing =
    op.kind === 'time-interpolated' || op.kind === 'zoom-time' ? op.easing : 'linear'
  const timeOpacityDelayMs =
    op.kind === 'time-interpolated' || op.kind === 'zoom-time' ? op.delayMs : 0

  // PR 3: project animated color / size stops off each union. Because
  // ColorValue.time-interpolated carries a `base` fallback, we emit the
  // base through `fill:` / `stroke:` — downstream code uses it when
  // time-factor reads aren't active yet (pre-delay frames).
  const timeFillStops: TimeStop<[number, number, number, number]>[] | null =
    node.fill.kind === 'time-interpolated' ? node.fill.stops : null
  const timeStrokeStops: TimeStop<[number, number, number, number]>[] | null =
    node.stroke.color.kind === 'time-interpolated' ? node.stroke.color.stops : null
  const timeSizeStops: TimeStop<number>[] | null =
    node.size.kind === 'time-interpolated' ? node.size.stops : null
  const timeStrokeWidthStops = node.stroke.timeWidthStops ?? null
  const timeDashOffsetStops = node.stroke.timeDashOffsetStops ?? null

  return {
    targetName: node.sourceRef,
    fill: colorToHex(node.fill),
    stroke: colorToHex(node.stroke.color),
    strokeWidth: node.stroke.width,
    projection: node.projection,
    visible: node.visible,
    opacity: op.kind === 'constant' ? op.value : 1.0,
    size: node.size.kind === 'constant' ? node.size.value : null,
    zoomOpacityStops,
    zoomSizeStops: node.size.kind === 'zoom-interpolated' ? node.size.stops : null,
    shaderVariant,
    filterExpr: node.filter,
    geometryExpr: node.geometry,
    sizeUnit: (node.size.kind === 'constant' || node.size.kind === 'data-driven') ? (node.size.unit ?? null) : null,
    sizeExpr: node.size.kind === 'data-driven' ? node.size.expr : null,
    billboard: node.billboard,
    anchor: node.anchor,
    shape: node.shape.kind === 'named' ? node.shape.name : null,
    shapeDefs: [],
    linecap: node.stroke.linecap,
    linejoin: node.stroke.linejoin,
    miterlimit: node.stroke.miterlimit,
    dashArray: node.stroke.dashArray,
    dashOffset: node.stroke.dashOffset,
    patterns: node.stroke.patterns,
    strokeOffset: node.stroke.offset,
    strokeAlign: node.stroke.align,
    timeOpacityStops,
    timeFillStops,
    timeStrokeStops,
    timeStrokeWidthStops,
    timeSizeStops,
    timeDashOffsetStops,
    timeOpacityLoop,
    timeOpacityEasing,
    timeOpacityDelayMs,
  }
}

function colorToHex(color: ColorValue): string | null {
  if (color.kind === 'none') return null
  if (color.kind === 'constant') return rgbaToHex(color.rgba)
  // For time-interpolated colors, the `base` snapshot is the fallback
  // pre-animation value — emitting it as a hex keeps the existing
  // shader-variant generator and raw pixel readback paths happy.
  if (color.kind === 'time-interpolated') return rgbaToHex(color.base)
  return null
}
