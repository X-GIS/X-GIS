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
  /** #1252 — the variant's own EXTRUDED pipelines (vs_main_ecef_extruded +
   *  fs_fill_extrude) bound to this variant's pipeline layout, so a
   *  data-driven fill (feature bind group) can extrude. The shared base
   *  extruded pipeline is base-layout only and mismatches the feature bind
   *  group; the VTR routes per-feature extrude to these when the show carries
   *  a variant. STENCIL_WRITE main + STENCIL_TEST fallback, mirroring the
   *  renderer-level fillPipelineExtruded / …Fallback. */
  fillPipelineExtruded: GPURenderPipeline
  fillPipelineExtrudedFallback: GPURenderPipeline
  fillPipelineExtrudedNoPick: GPURenderPipeline
  fillPipelineExtrudedFallbackNoPick: GPURenderPipeline
}

/** Easing function used between adjacent time-interpolated stops. */
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

// ─── Paint sub-bundles — SINGLE SOURCE from @xgis/compiler ──────────
//
// The four runtime paint-concern interfaces below `extends` the CANONICAL
// compiler interfaces (`@xgis/compiler` FillPaint/LinePaint/CirclePaint/
// ExtrudePaint), so a new paint property added on the compiler side flows
// here AUTOMATICALLY — there is no hand-maintained mirror to drift. This
// kills the recurring class where a compiler ShowCommand field read by the
// runtime (VTR/point-renderer) wasn't mirrored here: `bun run build` (Vite,
// runtime type-stripped) + vitest don't typecheck it, only CI `tsc --build`
// did — so the drift shipped green and went red on CI. Same fix the codebase
// already applied to `ShaderVariantInfo` above (line 16).
//
// Each interface adds ONLY the runtime-only bake/resolve fields (`fillPatternUV`,
// `resolvedFillRgba`, `zoomStrokeWidthStops`, …) and `Omit`s + re-declares the
// handful of fields whose RUNTIME optionality is deliberately looser than the
// compiler's (compiler emits them required; synthetic / hand-built shows omit
// them) — `fillPattern`, `linePattern`, `dashArrayShape`, `dashOffsetShape`,
// `circleStrokeOpacityShape`, `extrude`, `extrudeBase`. Those few re-declared
// fields are the only remaining manual surface; everything else is inherited.

/** Polygon fill paint axes. The compiler-emitted paint fields (fill,
 *  fill-translate(+anchor/shape), fill-antialias, …) are INHERITED from the
 *  canonical `@xgis/compiler` FillPaint — single source of truth, so a new
 *  fill paint property added on the compiler side flows here automatically
 *  with NO manual mirror to drift (the drift the old re-declaration caused).
 *  This adds only the RUNTIME-ONLY bake/resolve fields and re-loosens the
 *  one field whose runtime optionality differs (`fillPattern` — synthetic /
 *  hand-built shows omit it). */
export interface FillPaint extends Omit<import('@xgis/compiler').FillPaint, 'fillPattern'> {
  /** Mapbox `paint.fill-pattern` constant sprite name. Runtime loosens the
   *  compiler's required form to optional (synthetic shows omit it). */
  fillPattern?: string | null
  /** Runtime-only — fill-pattern Stage 2 resolved data (map.ts._resolveFillPatterns):
   *  VTR routes pattern shows to fillPipelinePatternGround with these packed
   *  into the per-tile uniform. Undefined while the atlas loads. */
  fillPatternUV?: [number, number, number, number] | null // (u0, v0, u1, v1)
  fillPatternRepeatM?: [number, number] | null // metres per pattern tile
  /** Runtime-only — per-frame animated fill override (map.ts
   *  classifyVectorTileShows), bypassing VTR's hex-string parse cache. */
  resolvedFillRgba?: [number, number, number, number] | null
}

/** Line / polygon-outline paint axes. The compiler-emitted stroke fields
 *  (stroke, strokeWidth, lin{e}cap/join, dash*, strokeTranslate*, roundLimit,
 *  patterns, …) are INHERITED from the canonical `@xgis/compiler` LinePaint —
 *  single source, no manual mirror to drift. Adds only the RUNTIME-ONLY bake/
 *  resolve fields + re-loosens `linePattern` (synthetic shows omit it). */
export interface LinePaint extends Omit<
  import('@xgis/compiler').LinePaint,
  'linePattern' | 'dashArrayShape' | 'dashOffsetShape'
> {
  /** Mapbox `paint.line-pattern` constant sprite name. Runtime loosens to optional. */
  linePattern?: string | null
  /** WS-1 dash shapes — compiler emits them required (`| null`); runtime loosens
   *  to optional so synthetic / hand-built shows can omit them. */
  dashArrayShape?: import('@xgis/compiler').PropertyShape<number[]> | null
  dashOffsetShape?: import('@xgis/compiler').PropertyShape<number> | null
  /** Runtime-only — line-pattern Stage 2 mirror (map.ts._resolveFillPatterns):
   *  VTR routes pattern shows to linePipelinePattern with these packed in. */
  linePatternUV?: [number, number, number, number] | null
  linePatternRepeatM?: [number, number] | null
  /** Runtime-only — per-frame animated stroke override. See `resolvedFillRgba`. */
  resolvedStrokeRgba?: [number, number, number, number] | null
  /** Runtime-only — line-width zoom stops the renderer evaluates per frame
   *  against camera.zoom (vs the worker-baked strokeWidthExpr). Overrides
   *  `strokeWidth` when present. */
  zoomStrokeWidthStops?: { zoom: number; value: number }[]
  zoomStrokeWidthStopsBase?: number
}

/** Circle / point-marker paint axes — INHERITED from the canonical
 *  `@xgis/compiler` CirclePaint (single source of truth, no manual mirror);
 *  runtime only re-loosens `circleStrokeOpacityShape` to optional (synthetic
 *  shows omit it). */
export interface CirclePaint extends Omit<
  import('@xgis/compiler').CirclePaint,
  'circleStrokeOpacityShape'
> {
  circleStrokeOpacityShape?: import('@xgis/compiler').PropertyShape<number> | null
}

/** Heatmap paint axes (Mapbox `heatmap-*`, Phase R) — INHERITED from the
 *  canonical `@xgis/compiler` HeatmapPaint (single source, no mirror to drift).
 *  `isHeatmap` routes the GeoJSON Point/MultiPoint fork in map.ts to the
 *  HeatmapRenderer instead of the SDF point path. No runtime-only fields, so
 *  a direct alias to the canonical compiler type (a bare `extends import(...)`
 *  is a TS2499; an alias takes the inline import cleanly). */
export type HeatmapPaint = import('@xgis/compiler').HeatmapPaint

/** 3D extrusion paint axes — INHERITED from the canonical `@xgis/compiler`
 *  ExtrudePaint (single source, incl. fillExtrusionVerticalGradient); runtime
 *  only re-loosens extrude / extrudeBase to optional (synthetic / flat-fill
 *  shows omit them). The inline union is structurally the compiler's ExtrudeValue. */
export interface ExtrudePaint extends Omit<
  import('@xgis/compiler').ExtrudePaint,
  'extrude' | 'extrudeBase'
> {
  extrude?:
    | { kind: 'none' }
    | { kind: 'constant'; value: number }
    | { kind: 'feature'; expr: { ast: unknown }; fallback: number }
  extrudeBase?:
    | { kind: 'none' }
    | { kind: 'constant'; value: number }
    | { kind: 'feature'; expr: { ast: unknown }; fallback: number }
}

export interface ShowCommand extends FillPaint, LinePaint, CirclePaint, ExtrudePaint, HeatmapPaint {
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
  /** `coverage` LAYER paint (#1158 INC-D): colour-ramp LUT name + `[lo, hi]` display
   *  window, threaded from the compiler ShowCommand (emit-commands.ts) so rebuildLayers
   *  arms the CoverageRenderer off the drawing layer (a coverage source is data-only —
   *  the raster-color / raster-color-range analogue). Undefined on every non-coverage
   *  layer. Sibling of the compiler ShowCommand field (two-sibling rule). */
  ramp?: string
  range?: readonly [number, number]
  /** Optional MVT layer slice within the source. When set, the
   *  catalog returns only that slice's TileData and the renderer
   *  draws only its geometry. Mapbox-style `source-layer` semantics
   *  (camelCase here for lexer compatibility). */
  sourceLayer?: string
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
  /** Compiler-emitted variant info. Inlined here as the canonical
   *  ShaderVariant type so runtime accesses (palette routing flags,
   *  computeBindings, categoryOrder, etc.) stay aligned with the
   *  compiler — same drift-elimination pattern as ShaderVariantInfo
   *  at line 595. */
  shaderVariant?: import('@xgis/compiler').ShaderVariant | null
  filterExpr?: { ast: unknown } | null // AST expression for per-feature filtering
  geometryExpr?: { ast: unknown } | null
  sizeExpr?: { ast: unknown } | null
  sizeUnit?: string | null
  billboard?: boolean
  anchor?: 'center' | 'bottom' | 'top'
  shape?: string | null
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
