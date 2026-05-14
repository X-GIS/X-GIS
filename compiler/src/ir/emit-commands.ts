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
import { collectPalette, type Palette } from '../codegen/palette'
import { planComputeKernels, type ComputePlanEntry } from '../codegen/compute-plan'

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
  /** Dash offset as a PropertyShape — composed from the static
   *  `stroke.dashOffset` and any `time-interpolated` animation
   *  (`stroke.timeDashOffsetStops`) plus the layer-level lifecycle
   *  metadata (loop / easing / delayMs). `null` means no offset
   *  authored; `kind: 'constant'` carries the static-only case.
   *  dashOffset is a STRUCTURAL stroke attribute (drift of the dash
   *  pattern along the line), not a paint axis — that's why it has
   *  its own field instead of joining the PaintShapes bundle. */
  dashOffsetShape: import('./property-types').PropertyShape<number> | null
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
  /** Typed `PropertyShape<T>` bundle for every animatable / shape-able
   *  paint axis. The flat `fill` / `stroke` / `opacity` / `strokeWidth`
   *  / `size` fields above are RESOLVED views of the same data:
   *  - `fill` / `stroke` carry the static-hex form used by shader
   *    uniform binding (no per-frame allocation for the common case).
   *  - `opacity` / `size` carry the per-frame resolved scalar that
   *    bucket-scheduler computes from the corresponding shape.
   *  - `paintShapes.*` carry the full evaluation shape (constant /
   *    zoom-interpolated / time-interpolated / zoom-time / data-driven)
   *    for the animation + classifier pipeline.
   *
   *  Different roles, different access patterns — not redundant. Reads
   *  go to whichever view fits the caller's cost model. */
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
  /** Scene-wide constant/gradient pool (P3 Step 1, see palette.ts).
   *  Runtime calls `uploadPalette` to create the GPU storage textures
   *  and binds them to every variant whose `paletteColorGradients`
   *  is non-empty. Empty (or absent) when no zoom-interpolated paint
   *  property was eligible for textureSampleLevel routing. */
  palette?: import('../codegen/palette').Palette
  /** P4 plan — one entry per (renderNodeIndex, paintAxis) that
   *  needs a compute kernel evaluation. The runtime consumes this
   *  to build TileComputeResources per visible tile, dispatch
   *  kernels each frame, and merge the compute output buffer
   *  references into the per-show ShaderVariant via
   *  `mergeComputeAddendumIntoVariant`. Absent (or empty) when no
   *  paint axis routes to compute — runtime falls back to the
   *  legacy uniform / inline-fragment path uniformly. */
  computePlan?: ComputePlanEntry[]
}

/**
 * Convert an IR Scene to the legacy SceneCommands format
 * that the existing runtime expects.
 */
/** Compiler emit options. Reserved for opt-in features that need
 *  matching runtime infrastructure before they're safe to enable —
 *  flipping these unconditionally would generate WGSL that fails
 *  pipeline validation against the existing bind-group layouts. */
export interface EmitOptions {
  /** P3 Step 3c gate. When true, scene-level zoom-interpolated paint
   *  properties emit `textureSampleLevel` against the gradient atlas
   *  (P3 Step 3b emission); when false (default), they keep the
   *  legacy `u.fill_color` uniform path. Runtime callers MUST set
   *  this to true ONLY after they've extended the polygon bind-group
   *  layout to include @binding(2..4) palette texture / sampler
   *  entries and bound them via `uploadPalette`. */
  enablePaletteSampling?: boolean
}

export function emitCommands(scene: Scene, opts?: EmitOptions): SceneCommands {
  const loads: LoadCommand[] = scene.sources.map(src => ({
    name: src.name,
    url: src.url,
    type: src.type,
    layers: src.layers,
  }))

  // Walk the IR once to collect every ZOOM-only paint literal /
  // gradient (P3 Step 1). Always emit the palette into SceneCommands
  // so a runtime that opts INTO `enablePaletteSampling` later in
  // its boot has the data ready. Shader-gen integration is gated
  // separately — without the runtime bind-group extension, an
  // active palette would generate WGSL with @binding(2..4)
  // references that fail pipeline validation against
  // mr-baseBindGroupLayout.
  const palette = collectPalette(scene)
  const variantPalette = opts?.enablePaletteSampling ? palette : undefined
  const shows: ShowCommand[] = scene.renderNodes.map(node => emitShow(node, variantPalette))

  // Compute plan is walked unconditionally — the cost is one scene
  // walk per compile, dominated by paint-routing's deps analysis
  // (already linear in the scene's expression count). The runtime
  // ignores `computePlan` when its compute path isn't wired up yet,
  // so emitting it is back-compat by construction.
  const computePlan = planComputeKernels(scene)

  return {
    loads, shows, symbols: scene.symbols, palette,
    ...(computePlan.length > 0 ? { computePlan } : {}),
  }
}

function emitShow(node: RenderNode, palette?: Palette): ShowCommand {
  // Generate shader variant for this layer. Palette is only forwarded
  // when the caller set `enablePaletteSampling`; otherwise the
  // variant falls back to the legacy `u.fill_color` uniform path
  // (P3 Step 3b's strict back-compat branch).
  const shaderVariant = generateShaderVariant(node, undefined, palette)

  const op = node.opacity

  // Lifecycle metadata (loop / easing / delayMs) is shared across every
  // animated property on a layer because a layer hosts one
  // `animation-<name>` reference at a time. lower.ts stamps it onto
  // `node.animationMeta` when ANY property is keyframe-animated;
  // emit-commands just reads it. Falls back to safe defaults when no
  // animation is attached at all.
  const meta = node.animationMeta ?? { loop: false, easing: 'linear' as Easing, delayMs: 0 }

  // dashOffset: compose into a single PropertyShape carrying lifecycle
  // metadata inline. Time-interpolated when keyframes exist, constant
  // otherwise. `null` means no offset authored.
  const dashOffsetTimeStops = node.stroke.timeDashOffsetStops ?? null
  let dashOffsetShape: import('./property-types').PropertyShape<number> | null = null
  if (dashOffsetTimeStops !== null && dashOffsetTimeStops.length > 0) {
    dashOffsetShape = {
      kind: 'time-interpolated',
      stops: dashOffsetTimeStops,
      loop: meta.loop,
      easing: meta.easing,
      delayMs: meta.delayMs,
    }
  } else if (node.stroke.dashOffset !== undefined) {
    dashOffsetShape = { kind: 'constant', value: node.stroke.dashOffset }
  }

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
    dashOffsetShape,
    patterns: node.stroke.patterns,
    strokeOffset: node.stroke.offset,
    strokeAlign: node.stroke.align,
    strokeBlur: node.stroke.blur,
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
