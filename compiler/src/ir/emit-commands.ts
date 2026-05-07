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
  /** Optional MVT layer subset for PMTiles sources. See the parallel
   *  field on the legacy `interpreter.ts` LoadCommand. */
  layers?: string[]
}

export interface ShowCommand {
  targetName: string
  /** DSL layer name from `layer <name> { ... }`. Distinct from
   *  `targetName` (source name) when two layers share a source.
   *  Legacy `show <name> { ... }` syntax mirrors `targetName` here. */
  layerName?: string
  /** Optional MVT layer slice within the source. When set, the
   *  catalog returns only that slice's TileData and the renderer
   *  draws only its geometry. Mapbox-style `source-layer`
   *  semantics (camelCase here for lexer compatibility). */
  sourceLayer?: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  /** Optional per-feature stroke-width override AST. Compiler-
   *  synthesized only by the layer-merge pass when grouping
   *  same-source-layer xgis layers whose only stroke difference is
   *  the width (roads_minor / primary / highway pattern). The
   *  runtime worker evaluates this against each feature and writes
   *  the resolved width into the line segment buffer's per-segment
   *  slot; the line shader picks segment.width_px over the layer
   *  uniform when non-zero. */
  strokeWidthExpr?: DataExpr
  projection: string
  visible: boolean
  /** CSS-style pointer interactivity. 'none' makes the layer non-pickable
   *  (writeMask:0 on the pick attachment so picks fall through). 'auto'
   *  is the default. */
  pointerEvents: 'auto' | 'none'
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
  /** 3D extrusion height. `none` = flat polygon (default). `constant`
   *  = uniform metres for every feature. `feature` = per-feature
   *  property name + fallback metres. The runtime branches the upload
   *  pipeline + binds the extruded vertex layout when set to anything
   *  other than 'none'. */
  extrude: import('./render-node').ExtrudeValue
}

export interface SceneCommands {
  loads: LoadCommand[]
  shows: ShowCommand[]
  symbols: { name: string; paths: string[] }[]
  /** Resolved canvas background fill `#rrggbb` / `#rrggbbaa`. Set
   *  by `background { fill: <color> }` in the .xgis program; the
   *  runtime applies it as the WebGPU clearValue. Absent → renderer
   *  default (dark navy). */
  background?: string
}

/**
 * Convert an IR Scene to the legacy SceneCommands format
 * that the existing runtime expects.
 */
export function emitCommands(scene: Scene): SceneCommands {
  const loads: LoadCommand[] = scene.sources.map(src => ({
    name: src.name,
    url: src.url,
    layers: src.layers,
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

  // Lifecycle metadata (loop / easing / delayMs) is shared across every
  // animated property on a layer because a layer hosts one
  // `animation-<name>` reference at a time. lower.ts stamps it onto
  // `node.animationMeta` when ANY property is keyframe-animated;
  // emit-commands just reads it. Falls back to safe defaults when no
  // animation is attached at all.
  //
  // BUG FIX (PR 3 follow-up): previously we read these from the opacity
  // union only. A layer that animated color / width / dash-offset but
  // kept opacity constant got loop=false silently — one full cycle then
  // frozen at the last stop. The animationMeta single source of truth
  // makes that miscall structurally impossible.
  const meta = node.animationMeta ?? { loop: false, easing: 'linear' as Easing, delayMs: 0 }
  const timeOpacityLoop = meta.loop
  const timeOpacityEasing = meta.easing
  const timeOpacityDelayMs = meta.delayMs

  return {
    targetName: node.sourceRef,
    sourceLayer: node.sourceLayer,
    /** DSL layer name (e.g., `layer borders { ... }` → 'borders'). The
     *  data path uses `targetName` (source name) to look up tiles, but
     *  the user-facing `map.getLayer(name)` API matches the DSL layer
     *  name. Two layers can share a source — they get distinct
     *  `layerName`s and distinct entries in the layer registry. */
    layerName: node.name,
    fill: colorToHex(node.fill),
    stroke: colorToHex(node.stroke.color),
    strokeWidth: node.stroke.width,
    strokeWidthExpr: node.stroke.widthExpr,
    projection: node.projection,
    visible: node.visible,
    pointerEvents: node.pointerEvents,
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
    extrude: node.extrude,
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
