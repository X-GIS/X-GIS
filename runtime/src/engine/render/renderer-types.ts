// ═══ X-GIS Map Renderer — shared types ═══
//
// Top-level type / interface declarations extracted verbatim from
// renderer.ts. renderer.ts re-exports the previously-exported ones so
// the public module surface stays byte-identical; internal types
// (RenderLayer) are imported without re-export.

import type { StyleProperties } from './renderer'

/** Runtime alias for the compiler-emitted ShaderVariant. Earlier this
 *  was a stripped local interface that fell behind every time the
 *  compiler added a field (palette routing, computeBindings, etc.),
 *  forcing 5+ `Property 'computeBindings' does not exist` errors at
 *  every renderer access. Pointing at the canonical compiler type
 *  removes the drift surface entirely. */
export type ShaderVariantInfo = import('@xgis/compiler').ShaderVariant

export interface CachedPipeline {
  fillPipeline: GPURenderPipeline
  /** Depth-disabled (`STENCIL_WRITE_NO_DEPTH`) mirror of `fillPipeline`
   *  for `extrude.kind === 'none'` ground layers. Coplanar painter's-
   *  order resolve depends on no draw writing depth — same role as the
   *  unconditional `fillPipelineGround` (renderer.ts:983), but bound
   *  to this variant's pipeline layout so feature-buffer-driven
   *  ground layers can use the painter's-order path too. */
  fillPipelineGround: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback: GPURenderPipeline
  /** Depth-disabled fallback (`STENCIL_TEST_NO_DEPTH`) for the
   *  parent-ancestor draw path. Mirrors `fillPipelineGround` but with
   *  stencil-test (only draws where current-zoom hasn't already
   *  filled). */
  fillPipelineGroundFallback: GPURenderPipeline
  linePipelineFallback: GPURenderPipeline
  /** Pickable=false mirror set: identical except `writeMask: 0` on the
   *  RG32Uint pick attachment, so layers with `pointer-events: none`
   *  draw their color but leave the pick texture's prior contents
   *  intact (picks fall through to the layer beneath). When picking is
   *  globally disabled, these alias the pickable pipelines (the
   *  colorTargets have no pick attachment so the writeMask is moot). */
  fillPipelineNoPick: GPURenderPipeline
  fillPipelineGroundNoPick: GPURenderPipeline
  linePipelineNoPick: GPURenderPipeline
  fillPipelineFallbackNoPick: GPURenderPipeline
  fillPipelineGroundFallbackNoPick: GPURenderPipeline
  linePipelineFallbackNoPick: GPURenderPipeline
}

/** Easing function used between adjacent time-interpolated stops. */
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export interface ShowCommand {
  /** Position of this show in the compiled Scene's renderNodes — the
   *  key the P4 compute plan uses to route output buffers back to
   *  fragment-shader paint axes. Compiler emits it; runtime callers
   *  (map.ts buildFeatureDataBuffer sites) read it. Optional for
   *  back-compat with hand-built ShowCommands in tests; the compute
   *  path falls back to 0 when absent. Mirrors the compiler-side
   *  `ShowCommand.renderNodeIndex` at emit-commands.ts:41. */
  renderNodeIndex?: number
  targetName: string
  /** DSL layer name (`layer <name> { source: <target> | ... }`). Used
   *  by `map.getLayer(name)` and `LayerIdRegistry` so two layers
   *  drawing the same source still resolve to distinct `XGISLayer`
   *  wrappers. Legacy syntax that lacks a separate layer name reuses
   *  `targetName`. */
  layerName?: string
  /** Mapbox `layer.minzoom` — layer is hidden when camera.zoom <
   *  minzoom. Without enforcement every sub-layer of a multi-zoom
   *  style renders at every zoom level (place city + state + town +
   *  village + POI all at z=1). The label render path and the
   *  polygon/line draw loop both consult this. */
  minzoom?: number
  /** Mapbox `layer.maxzoom` — layer is hidden when camera.zoom >=
   *  maxzoom. */
  maxzoom?: number
  /** Optional MVT layer slice within the source. When set, the
   *  catalog returns only that slice's TileData and the renderer
   *  draws only its geometry. Mapbox-style `source-layer` semantics
   *  (camelCase here for lexer compatibility). */
  sourceLayer?: string
  fill: string | null
  /** iter-177 Mapbox `paint.fill-pattern` constant sprite name. Map.ts
   *  resolves the sprite atlas centre pixel at frame time and writes
   *  the colour into `resolvedFillRgba`; this string is the source. */
  fillPattern?: string | null
  /** iter-183 — fill-pattern Stage 2 per-show resolved data. Populated
   *  by `map.ts._resolveFillPatterns` once the iconStage's sprite
   *  atlas is loaded. VTR reads these and routes pattern shows to the
   *  `fillPipelinePatternGround` pipeline with the values packed into
   *  the per-tile uniform's `fill_color` / `fill_translate` slots.
   *  Stays undefined while the atlas is still loading; the Stage 1
   *  `resolvedFillRgba` centre-pixel colour remains as the fallback. */
  fillPatternUV?: [number, number, number, number] | null  // (u0, v0, u1, v1)
  fillPatternRepeatM?: [number, number] | null             // metres per pattern tile
  /** iter-185 — line-pattern Stage 2 mirror. Populated by
   *  `map.ts._resolveFillPatterns`; VTR routes pattern shows to
   *  `linePipelinePattern` + writes UV bbox into stroke_color slot
   *  and repeat metres into layer.color.r / .a. */
  linePatternUV?: [number, number, number, number] | null
  linePatternRepeatM?: [number, number] | null
  /** iter-178 Mapbox `paint.line-pattern` constant sprite name —
   *  stroke-side mirror of fillPattern. Map.ts writes the resolved
   *  sprite centre RGBA into `resolvedStrokeRgba`. */
  linePattern?: string | null
  stroke: string | null
  strokeWidth: number
  /** Optional per-feature stroke-width override AST. Set by the
   *  compiler's mergeLayers pass when folding same-source-layer xgis
   *  layers with different widths. The MVT worker evaluates this AST
   *  against each feature's properties and writes the resolved width
   *  into the line segment buffer's per-segment slot; the shader
   *  picks `segment.width_px` over the layer uniform when non-zero. */
  strokeWidthExpr?: { ast: unknown }
  /** Mapbox `paint.line-width: ["interpolate", curve, ["zoom"], …]` —
   *  pure zoom stops the renderer evaluates per frame against
   *  camera.zoom. Lets the line widen smoothly inside one tile-zoom
   *  bracket (vs. the strokeWidthExpr / worker bake which freezes
   *  the width at tile-decode zoom). When present, overrides
   *  `strokeWidth`. */
  zoomStrokeWidthStops?: { zoom: number; value: number }[]
  zoomStrokeWidthStopsBase?: number
  /** Optional per-feature stroke-colour override AST. Mirror of
   *  strokeWidthExpr; the worker resolves per feature, packs RGBA8
   *  into a u32, and writes it into the line segment buffer's
   *  `color_packed` slot. Line shader unpacks and uses when alpha > 0. */
  strokeColorExpr?: { ast: unknown }
  projection: string
  visible: boolean
  /** CSS-style pointer interactivity. 'none' marks the layer as non-
   *  pickable so the writeMask:0 pipeline variant skips its pickId
   *  write — picks fall through to the layer beneath. 'auto' (default)
   *  is fully pickable. */
  pointerEvents?: 'auto' | 'none'
  /** Per-frame composed opacity (resolved-value channel). Bucket-
   *  scheduler writes this in `effectiveShow` after evaluating
   *  paintShapes.opacity; downstream renderers read it as a scalar. */
  opacity: number
  /** Per-frame composed size. Same resolved-value channel pattern as
   *  `opacity`. `null` when the layer doesn't author a size. */
  size?: number | null
  /** Dash offset as a PropertyShape — composed by emit-commands from
   *  the static `stroke.dashOffset` and any time-interpolated
   *  animation plus the layer-level lifecycle metadata. `null` means
   *  no offset authored. dashOffset is a STRUCTURAL stroke attribute
   *  (drift of the dash pattern along the line), not a paint axis —
   *  that's why it lives outside the PaintShapes bundle. */
  dashOffsetShape?: import('@xgis/compiler').PropertyShape<number> | null
  // Per-frame animated overrides. Populated by map.ts
  // classifyVectorTileShows() when an animation is active, so VTR and
  // line-renderer don't need to know about time stops — they just read
  // the pre-resolved value. Bypasses VTR's hex-string parse cache.
  resolvedFillRgba?: [number, number, number, number] | null
  resolvedStrokeRgba?: [number, number, number, number] | null
  /** Compiler-emitted variant info. Inlined here as the canonical
   *  ShaderVariant type so runtime accesses (palette routing flags,
   *  computeBindings, categoryOrder, etc.) stay aligned with the
   *  compiler — same drift-elimination pattern as ShaderVariantInfo
   *  at line 595. */
  shaderVariant?: import('@xgis/compiler').ShaderVariant | null
  filterExpr?: { ast: unknown } | null  // AST expression for per-feature filtering
  geometryExpr?: { ast: unknown } | null
  sizeExpr?: { ast: unknown } | null
  sizeUnit?: string | null
  billboard?: boolean
  anchor?: 'center' | 'bottom' | 'top'
  shape?: string | null
  /** 3D extrusion height. Set by the compiler from the layer's
   *  `extrude:` keyword; VTR branches its upload + fill draw onto
   *  the extruded pipeline when `kind !== 'none'`. The feature form
   *  carries an AST expression (any shape — field access, binary,
   *  function call) that the MVT worker evaluates per feature. */
  extrude?:
    | { kind: 'none' }
    | { kind: 'constant'; value: number }
    | { kind: 'feature'; expr: { ast: unknown }; fallback: number }
  /** Mapbox `fill-extrusion-base` — wall bottom z. Same shape as
   *  `extrude`; default `none` (=> z=0 ground). */
  extrudeBase?:
    | { kind: 'none' }
    | { kind: 'constant'; value: number }
    | { kind: 'feature'; expr: { ast: unknown }; fallback: number }
  // Line styling (Phase 2+)
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  dashArray?: number[]
  /** WS-1 — per-frame zoom-interp dasharray (STEP). resolveShow resolves it
   *  into ResolvedShow.dashArray; VTR prefers that over the constant. */
  dashArrayShape?: import('@xgis/compiler').PropertyShape<number[]> | null
  /** WS-1 — per-frame zoom-interp circle-stroke-opacity. PointRenderer
   *  resolves it per frame and multiplies it into the circle's baked
   *  stroke alpha (feat_data slot 8). `null` = constant-only (folded into
   *  the stroke hex alpha at convert time). */
  circleStrokeOpacityShape?: import('@xgis/compiler').PropertyShape<number> | null
  patterns?: {
    shape: string
    spacing: number
    spacingUnit?: 'm' | 'px' | 'km' | 'nm'
    size: number
    sizeUnit?: 'm' | 'px' | 'km' | 'nm'
    offset?: number
    offsetUnit?: 'm' | 'px' | 'km' | 'nm'
    startOffset?: number
    anchor?: 'repeat' | 'start' | 'end' | 'center'
  }[]
  /** Lateral parallel offset in CSS px (Mapbox `paint.line-offset`). */
  strokeOffset?: number
  /** Stroke alignment ('inset' / 'outset' shifts by ±half-width). */
  strokeAlign?: 'center' | 'inset' | 'outset'
  /** Mapbox `paint.line-blur` — edge feathering in CSS px (0 = crisp). */
  strokeBlur?: number
  /** Mapbox `paint.line-gap-width` — px gap between two parallel
   *  strokes composing a road casing. > 0 triggers the line renderer's
   *  double-draw path with offsets ±(gap + stroke) / 2. */
  strokeGapWidth?: number
  /** Mapbox `paint.fill-translate` x — CSS-px viewport offset on
   *  fills, +right. Runtime baker writes (px * 2 / canvasWidth) into
   *  uniformF32[46] so the vertex shader can apply post-MVP. */
  fillTranslateX?: number
  /** Mapbox `paint.fill-translate` y — CSS-px viewport offset on
   *  fills, +down. Runtime baker writes (px * 2 / canvasHeight) into
   *  uniformF32[47]; vertex shader negates internally for NDC y. */
  fillTranslateY?: number
  /** Mapbox `paint.fill-antialias` opt-out. Default (undefined / true)
   *  keeps the current fill render path; `false` is packed into the
   *  polygon uniform's cam_ecef_off_h.w lane (f32 slot 55) so the fill
   *  fragment can skip the sphere-rim smoothstep AA fade (hard edges). */
  fillAntialias?: boolean
  /** Mapbox `paint.fill-extrusion-vertical-gradient` opt-out. Default
   *  (undefined / true) keeps the gradient ramp; `false` is packed into
   *  the polygon uniform's cam_ecef_off_l.w lane (f32 slot 59) so the
   *  extrude vertex shader skips the vertical-gradient wall ramp. */
  fillExtrusionVerticalGradient?: boolean
  /** Mapbox `paint.circle-translate` x — CSS-px viewport offset on
   *  circles, +right. Point renderer writes into circle_params.x of
   *  the point uniform; vertex shader applies post-MVP. Default 0. */
  circleTranslateX?: number
  /** Mapbox `paint.circle-translate` y — CSS-px viewport offset on
   *  circles, +down. Point renderer writes into circle_params.y;
   *  vertex shader negates for NDC y. Default 0. */
  circleTranslateY?: number
  /** Mapbox `paint.circle-blur` — CSS-px feathering added to the
   *  smoothstep AA band in the point fragment shader. Default 0 = crisp. */
  circleBlur?: number
  /** Mapbox `paint.line-translate` x — CSS-px viewport offset on
   *  lines, +right. Runtime bakes (px * 2 / canvasWidth) into the
   *  line layer uniform's line_translate_x slot (buf[47]). */
  strokeTranslateX?: number
  /** Mapbox `paint.line-translate` y — CSS-px viewport offset on
   *  lines, +down. Runtime bakes (px * 2 / canvasHeight) into
   *  line_translate_y slot (buf[48]); shader negates for NDC y. */
  strokeTranslateY?: number
  /** WS-1 — per-frame zoom-interp translate (per-axis scalar
   *  PropertyShape). resolveShow resolves fill/line each frame into
   *  ResolvedShow.{fill,stroke}Translate{X,Y}; circle resolves in the
   *  point-renderer. Prefer the shape over the constant *TranslateX/Y. */
  fillTranslateXShape?: import('@xgis/compiler').PropertyShape<number>
  fillTranslateYShape?: import('@xgis/compiler').PropertyShape<number>
  circleTranslateXShape?: import('@xgis/compiler').PropertyShape<number>
  circleTranslateYShape?: import('@xgis/compiler').PropertyShape<number>
  strokeTranslateXShape?: import('@xgis/compiler').PropertyShape<number>
  strokeTranslateYShape?: import('@xgis/compiler').PropertyShape<number>
  // Stable u16 layer ID assigned by `XGISMap` via `LayerIdRegistry` after
  // the compiler emits this command. Threaded into every per-tile uniform
  // write so the fragment shader can stamp the pick texture's G channel
  // with `(instanceId << 16) | layerId`. 0 = unregistered (sentinel).
  pickId?: number
  /** Typed paint-property bundle (Plan Step 1b/1c). Mirrors the legacy
   *  flat fields above (fill / stroke / strokeWidth / opacity / size +
   *  their zoom* / time* companions). Consumers migrating off the
   *  flat-field stitching pattern read paintShapes directly — the
   *  bucket-scheduler's opacity resolution does this today, with
   *  fill / stroke / strokeWidth / size to follow (Step 1c.3). The
   *  field is required because the legacy interpreter (interpreter.ts)
   *  and the compiler's emit-commands both populate it; bucket-
   *  scheduler can drop its legacy-field fallback now. */
  paintShapes: import('@xgis/compiler').PaintShapes
  /** Per-feature label spec (Mapbox `symbol` text / icon). Compiler's
   *  ShowCommand carries the full LabelDef; the runtime renderer only
   *  needs the presence check + text/size for the SDF stage, so the
   *  type here is the structurally-narrower compiler export. Without
   *  this field, show-source-maps.ts:149's `show.label !== undefined`
   *  check failed TS2339. */
  label?: import('@xgis/compiler').LabelDef
}

// ═══ Render Layer ═══

export interface RenderLayer {
  show: ShowCommand
  props: StyleProperties
  polygonVertexBuffer: GPUBuffer | null
  polygonIndexBuffer: GPUBuffer | null
  polygonIndexCount: number
  lineVertexBuffer: GPUBuffer | null
  lineIndexBuffer: GPUBuffer | null
  lineIndexCount: number
  // Per-layer specialized pipelines (null = use shared default)
  fillPipeline: GPURenderPipeline | null
  linePipeline: GPURenderPipeline | null
  // Per-feature data
  featureDataBuffer: GPUBuffer | null
  perLayerBindGroup: GPUBindGroup | null
  // Stable u16 layer ID assigned by `LayerIdRegistry`, written into the
  // pick texture's G channel via `u.pick_id` so `pickAt()` can route the
  // hit back to the owning layer. 0 means "not registered" (sentinel).
  pickId: number
}
