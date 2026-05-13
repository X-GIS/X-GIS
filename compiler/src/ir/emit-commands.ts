// ═══ IR → SceneCommands Bridge ═══
// Converts IR Scene to the existing runtime SceneCommands format.
// This bridge allows the runtime to consume IR without changes.

import type { Scene, RenderNode, ColorValue, TimeStop, Easing, DataExpr } from './render-node'
import { rgbaToHex } from './render-node'
import type { PaintShapes } from './property-types'
import {
  colorValueToShape,
  sizeValueToShape,
} from './to-property-shape'
import { generateShaderVariant, type ShaderVariant } from '../codegen/shader-gen'

export type { ShaderVariant } from '../codegen/shader-gen'

export interface LoadCommand {
  name: string
  url: string
  /** Source `type:` from the DSL — `'geojson'` / `'pmtiles'` /
   *  `'tilejson'` / `'raster'` / `'xgvt'`. The runtime dispatches on
   *  this when set; falls back to URL-extension sniffing otherwise.
   *  Without it, a URL like `https://tiles.example.com/planet`
   *  (TileJSON manifest, no extension) gets misrouted as a generic
   *  GeoJSON `fetch().json()` and the engine crashes when it tries
   *  to read `data.features[0]` on the TileJSON document. */
  type?: string
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
  /** Mapbox `layer.minzoom` / `maxzoom` — gate per-frame visibility
   *  on the current camera zoom. See RenderNode for the rationale. */
  minzoom?: number
  maxzoom?: number
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
  /** Optional per-feature stroke colour override AST. Synthesised
   *  by the merge pass when group members differ in stroke colour;
   *  resolved by the worker into a packed RGBA8 u32 baked into the
   *  segment buffer. */
  strokeColorExpr?: DataExpr
  projection: string
  visible: boolean
  /** CSS-style pointer interactivity. 'none' makes the layer non-pickable
   *  (writeMask:0 on the pick attachment so picks fall through). 'auto'
   *  is the default. */
  pointerEvents: 'auto' | 'none'
  /** Per-frame composed opacity (the resolved-value channel).
   *  Bucket-scheduler writes this in `effectiveShow` after evaluating
   *  paintShapes.opacity; downstream renderers (VTR, line-renderer,
   *  point-renderer, map.ts composite) read it as a plain scalar. */
  opacity: number
  /** Per-frame composed size. Same resolved-value channel pattern as
   *  `opacity`. `null` when the layer doesn't author a size. */
  size: number | null
  shaderVariant: ShaderVariant | null
  filterExpr: DataExpr | null
  geometryExpr: DataExpr | null
  sizeUnit: string | null
  sizeExpr: DataExpr | null
  billboard: boolean
  anchor?: 'center' | 'bottom' | 'top'
  shape: string | null
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  dashArray?: number[]
  dashOffset?: number
  /** Stroke pattern stack — up to 3 repeated symbol slots laid along
   *  the line (Mapbox `line-pattern` superset). Each slot picks a
   *  shape from `ShapeRegistry` and gets its own spacing / anchor /
   *  offset. The line renderer evaluates all active slots per fragment. */
  patterns?: import('./render-node').StrokePattern[]
  /** Lateral parallel offset in pixels (positive = left of travel). */
  strokeOffset?: number
  /** Stroke alignment — 'inset' / 'outset' shift by ±half_width at runtime. */
  strokeAlign?: 'center' | 'inset' | 'outset'
  /** Mapbox `paint.line-blur` edge feathering in CSS px (0 = crisp). */
  strokeBlur?: number
  // ── Animation ──
  //
  // PaintShapes.* below carries every paint-property animation
  // (opacity / fill / stroke / strokeWidth / size). Only dashOffset
  // — a structural stroke attribute, not a paint axis — keeps its
  // own time-stop field here. The shared lifecycle metadata (loop /
  // easing / delayMs) is read off any animated PaintShape variant
  // (zoom-time / time-interpolated); these three flat fields stay
  // populated as the canonical metadata source for dashOffset's
  // animation, which has no PaintShape of its own.
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
  /** 3D extrusion BASE — z of the wall bottom (Mapbox
   *  `fill-extrusion-base`). Combined with `extrude` it carves out
   *  the `min_height` podium for buildings. `none` ⇒ z=0 default. */
  extrudeBase: import('./render-node').ExtrudeValue
  /** Optional per-feature text label spec (Batch 1c). When set, the
   *  runtime resolves `label.text` against each feature's properties
   *  via the format pipeline, projects the feature's anchor (point
   *  for points, centroid for polygons) to screen px, and submits
   *  the resulting string to the SDF text stage. Mapbox `symbol`
   *  layers map here via the converter; xgis source uses
   *  `label-["..."]` utility or `label { ... }` sub-block. */
  label?: import('./render-node').LabelDef
  /** Typed, post-discriminated-union paint property bundle (Plan
   *  Step 1b). Mirrors the flat `fill` / `stroke` / `opacity` /
   *  `strokeWidth` / `size` + their `zoom*Stops` / `time*Stops`
   *  companions above. Consumers migrating to the unified
   *  `PropertyShape<T>` model read this instead of stitching the
   *  flat fields together at every callsite — eliminating the
   *  "which field is truth-of-record" bug class that produced
   *  PR #95 / #97 / #104. Dual-written for now; flat fields will
   *  be removed once every runtime consumer has migrated
   *  (Step 1c). */
  paintShapes: PaintShapes
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
    type: src.type,
    layers: src.layers,
  }))

  const shows: ShowCommand[] = scene.renderNodes.map(emitShow)

  return { loads, shows, symbols: scene.symbols }
}

function emitShow(node: RenderNode): ShowCommand {
  // Generate shader variant for this layer
  const shaderVariant = generateShaderVariant(node)

  const op = node.opacity
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
    // Flatten the discriminated `StrokeWidthValue` into the three
    // back-compat ShowCommand fields the runtime currently consumes.
    // Exhaustive switch — TypeScript fails the build if a new variant
    // is added to StrokeWidthValue and emitting forgets to handle it,
    // which is exactly the safety net WS-4 of the spec-drift plan
    // installs against the PR #95 / #97 / #104 silent-default class.
    strokeWidth: node.stroke.width.kind === 'constant' ? node.stroke.width.value : 1,
    strokeWidthExpr: node.stroke.width.kind === 'data-driven' ? node.stroke.width.expr : undefined,
    strokeColorExpr: node.stroke.colorExpr,
    projection: node.projection,
    visible: node.visible,
    pointerEvents: node.pointerEvents,
    opacity: op.kind === 'constant' ? op.value : 1.0,
    size: node.size.kind === 'constant' ? node.size.value : null,
    shaderVariant,
    filterExpr: node.filter,
    geometryExpr: node.geometry,
    minzoom: node.minzoom,
    maxzoom: node.maxzoom,
    sizeUnit: (node.size.kind === 'constant' || node.size.kind === 'data-driven') ? (node.size.unit ?? null) : null,
    sizeExpr: node.size.kind === 'data-driven' ? node.size.expr : null,
    billboard: node.billboard,
    anchor: node.anchor,
    shape: node.shape.kind === 'named' ? node.shape.name : null,
    linecap: node.stroke.linecap,
    linejoin: node.stroke.linejoin,
    miterlimit: node.stroke.miterlimit,
    dashArray: node.stroke.dashArray,
    dashOffset: node.stroke.dashOffset,
    patterns: node.stroke.patterns,
    strokeOffset: node.stroke.offset,
    strokeAlign: node.stroke.align,
    strokeBlur: node.stroke.blur,
    timeDashOffsetStops,
    timeOpacityLoop,
    timeOpacityEasing,
    timeOpacityDelayMs,
    extrude: node.extrude,
    extrudeBase: node.extrudeBase,
    label: node.label,
    paintShapes: {
      fill: colorValueToShape(node.fill),
      stroke: colorValueToShape(node.stroke.color),
      // Stroke-width is the only paint property whose spatial
      // dependency (constant / zoom-stops / per-feature) and temporal
      // dependency (timeWidthStops on the parent StrokeValue) live
      // apart. Compose them here so paintShapes.strokeWidth is the
      // single authoritative shape — `zoom-time` if both exist,
      // `time-interpolated` if only time, otherwise the bare spatial
      // shape. Composition rule mirrors what bucket-scheduler does
      // today for opacity.
      strokeWidth: composeStrokeWidthShape(node.stroke.width, node.stroke.timeWidthStops, meta),
      opacity: node.opacity,
      size: sizeValueToShape(node.size),
    },
  }
}

/** Compose stroke-width's spatial half (StrokeWidthValue) with its
 *  temporal half (node.stroke.timeWidthStops) into a single
 *  PropertyShape. Mirrors emit-commands' existing dual-field output
 *  but produces one typed value instead of two parallel arrays. */
function composeStrokeWidthShape(
  spatial: import('./render-node').StrokeWidthValue,
  timeStops: TimeStop<number>[] | undefined,
  meta: { loop: boolean; easing: Easing; delayMs: number },
): import('./property-types').PropertyShape<number> {
  const sp = spatial
  if (timeStops === undefined || timeStops.length === 0) return sp
  if (sp.kind === 'zoom-interpolated') {
    return {
      kind: 'zoom-time',
      zoomStops: sp.stops,
      timeStops,
      loop: meta.loop,
      easing: meta.easing,
      delayMs: meta.delayMs,
    }
  }
  // Spatial is constant or data-driven — keep time as the dominant
  // axis. data-driven + time is rare (the worker bakes spatial into
  // segment slots; time stays per-frame); we surface it as the spatial
  // shape and let the renderer pick up the time stops separately
  // (matching today's behaviour where data-driven width ignores time).
  if (sp.kind === 'constant') {
    return {
      kind: 'time-interpolated',
      stops: timeStops,
      loop: meta.loop,
      easing: meta.easing,
      delayMs: meta.delayMs,
    }
  }
  return sp
}

function colorToHex(color: ColorValue): string | null {
  if (color.kind === 'none') return null
  if (color.kind === 'constant') return rgbaToHex(color.rgba)
  // For time-interpolated colors, the `base` snapshot is the fallback
  // pre-animation value — emitting it as a hex keeps the existing
  // shader-variant generator and raw pixel readback paths happy.
  if (color.kind === 'time-interpolated') return rgbaToHex(color.base)
  // Zoom-interpolated: pick FIRST stop as the static fallback. Mapbox
  // clamps to first-stop at zoom below the first stop boundary, and
  // first-stop is "the colour at the wider viewing extent" — usually
  // the most opaque / visible. Runtime path also picks up
  // zoomFillStops below and recomputes per frame; this hex is a
  // safety net for downstream consumers that ignore the stops.
  if (color.kind === 'zoom-interpolated' && color.stops.length > 0) {
    return rgbaToHex(color.stops[0]!.value)
  }
  return null
}
