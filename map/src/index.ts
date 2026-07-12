// @xgis/map public barrel — render/facade content extracted from runtime/src/engine during P3.
// Several blocks below are blanket re-exports of internal symbols; the true public API is a
// smaller subset (barrel-prune to that subset is a tracked follow-up). Each SELECTIVE `export {}`
// block notes the collision that forces it — a blanket `export *` there would ambiguously
// duplicate a symbol already surfaced above.

// Shader DSL (+ dsl-internal builders surfaced for content consumers) + globe-eye uniform.
export * from './shaders/dsl'
export * from './shaders/dsl/polygon'
export * from './shaders/dsl/oit-compose'
export * from './shaders/dsl/overdraw-fs'
export * from './render/globe-eye-uniform'
// Vertex/uniform formats + materials.
export * from './render/line-uniform-slots'
export * from './render/polygon-uniform-slots'
export * from './render/raster-uniform-slots'
export * from './render/heatmap-uniform-slots'
export * from './render/point-vertex-format'
export * from './render/line-vertex-format'
export * from './sprite/icon-vertex-format'
export * from './text/text-vertex-format'
export * from './render/material/material'
export * from './render/material/polygon-fill-material'
export * from './render/material/line-material'
export * from './render/material/line-composite-material'
export * from './render/material/point-material'
export * from './render/material/text-material'
export * from './render/material/icon-material'
export * from './render/material/heatmap-material'
export * from './render/material/raster-material'
// Paint/frame + VTR leaf types/helpers.
export * from './render/frame-draw-stats'
export * from './render/line-pattern'
export * from './render/vector-tile-renderer-types'
export * from './render/vector-tile-renderer-helpers'
// SELECTIVE: LayerDrawPhase collides with vector-tile-renderer-types above.
export { VectorTileRenderer, rotateTranslateForAnchor } from './render/vector-tile-renderer'
export * from './graticule'
export * from './render/point-renderer-types'
// Stateless point-packing authority (#722): stride-24 feat_data assembly + world-copy fan-out
// + translucent depth-sort, consumed by point-renderer.
export * from './render/point-feature-packer'
export * from './text/sdf-shape'
export * from './text/text-collision'
export * from './text/text-resolver'
export * from './text/sdf/atlas-state'
export * from './text/sdf/distance-transform'
export * from './text/sdf/pbf/varint'
// Content-side profiling / diagnostics / vertex crosscheck.
export * from './__profile__/perf-marks'
export * from './__profile__/alloc-counter'
export * from './diagnostics/render-trace'
export * from './render/__vertex-format-crosscheck'
export * from './debug-flags'
// Data-driven / heatmap color-ramp GPU texture builder.
export * from './color-ramp'
// Leaf machinery: compose/blur pipeline builders, compute feat_data packer, label feature
// source, tile-selection cache.
export * from './render/compose-pipelines'
export * from './render/compute-feature-packer'
export * from './render/label-feature-source'
export * from './render/tile-selection-cache'
// Renderers + gpu-tile-store + uniform-ring + sprite-atlas-host + glyph-rasterizer +
// glyphs.proto decoder + projection WGSL re-export shim.
export * from './render/heatmap-renderer'
export * from './render/raster-renderer'
export * from './render/gpu-tile-store'
export * from './render/uniform-ring'
export * from './sprite/sprite-atlas-host'
export * from './text/sdf/glyph-rasterizer'
export * from './text/sdf/pbf/glyphs-proto'
export * from './shaders/projection'
// SELECTIVE: line-renderer re-exports the line-pattern surface already star-exported above
// (via './render/line-pattern') — export only line-renderer's own symbols.
export {
  LineRenderer,
  buildLineSegments,
  LINE_SEGMENT_STRIDE_F32,
  LINE_SEGMENT_STRIDE_BYTES,
} from './render/line-renderer'
// Feature paint/filter helpers, tile-classification decision logic, extruded polygon-mesh
// builder, render-cache versioning / cache-key hashing, dirty-domain tracker.
export * from './feature-helpers'
export * from './tile-decision'
export * from './core/polygon-mesh'
export * from './_cache/versioned-state'
export * from './_cache/bundle-cache-key'
export * from './_cache/structural-key'
export * from './state/dirty'
// Graticule overlay renderer, tile prefetch scheduler, per-tile compute resources, GPU
// tile-upload coordinator, sprite-atlas GPU binder, PBF glyph provider + PBF→slot bridge.
export * from './render/graticule-renderer'
export * from './render/prefetch-scheduler'
export * from './render/tile-compute-resources'
export * from './render/upload-coordinator'
export * from './sprite/sprite-atlas-gpu'
export * from './text/sdf/pbf/glyph-provider'
export * from './text/sdf/pbf/pbf-to-slot'
// Per-layer compute lifecycle handle, standalone sprite-icon GPU pipeline, PBF glyph
// rasterizer chain + HTTP range cache + inline (air-gapped) glyph provider.
export * from './render/compute-layer-handle'
export * from './sprite/icon-renderer'
export * from './text/sdf/pbf-rasterizer'
export * from './text/sdf/pbf/glyph-pbf-cache'
export * from './text/sdf/pbf/inline-glyph-provider'
// Compute-layer registry aggregator, data-driven feature buffer + per-tile bind-group binder
// (#723 stableCategoryId), sprite icon-stage orchestrator, text-stage type declarations.
export * from './render/compute-layer-registry'
export * from './render/feature-data-binder'
export * from './sprite/icon-stage'
// Host DRAWING API (#797) — the `map.graphics` façade + its CPU/GPU atlas.
export * from './graphics/graphics-manager'
export * from './sprite/host-image-registry'
export * from './sprite/host-sprite-atlas-gpu'
export * from './text/text-stage-types'
// Renderer StyleProperties 6-file type-cycle SCC (renderer / renderer-types / renderer-helpers
// / paint-shape-resolve / pipeline-factory / frame-renderer) + glyph-atlas-host↔text-wrap cycle
// + bind-group-registry / text-stage-helpers. SELECTIVE: renderer re-exports ShaderVariantInfo /
// CachedPipeline / Easing / ShowCommand / interpolate* already surfaced via renderer-types /
// renderer-helpers — export only cross-package-consumed symbols; pipeline-factory has no external
// importer (omitted).
export { MapRendererContent } from './render/renderer'
export type { ShowCommand, Easing } from './render/renderer-types'
export {
  interpolateZoom,
  interpolateZoomRgba,
  interpolateTime,
  interpolateTimeColor,
  variantProducesFill,
} from './render/renderer-helpers'
export {
  resolveNumberShape,
  resolveColorShape,
  resolveSteppedShape,
  resolveArrayShape,
} from './render/paint-shape-resolve'
export { FrameRenderer } from './render/frame-renderer'
export { BindGroupRegistry } from './render/bind-group-registry'
export {
  GlyphAtlasHost,
  type GlyphAtlasHostOptions,
  type GlyphInfo,
} from './text/sdf/glyph-atlas-host'
export {
  wrapWithKnuthPlass,
  cjkBucketFor,
  wrapForTesting,
  codePointIsIdeographic,
  cjkBucketPx,
  CJK_SIZE_BUCKETS_CSS,
} from './text/text-wrap'
export {
  resolveTypography,
  applyTextTransform,
  stripCurveLineExtraScripts,
  evaluateVariableOffsetEm,
  variableAnchorOffsetEm,
  layoutCacheKey,
  textKeyFor,
  layoutCacheEntryValid,
  mlVerticalLayout,
  composeFontKey,
  verticalLayoutForTesting,
  ONE_EM,
  SHAPING_DEFAULT_OFFSET,
  CJK_FALLBACK_CHAIN,
  type LabelAnchor,
} from './text/text-stage-helpers'
// Render-loop label/projection helpers, point-renderer (its reflect(buildPointModule()) stays
// LAZY+memoized = the #612 map-load-crash guard), resolved-show paint cache, viewport-mode-
// controller, glyph-atlas GPU binder, text-renderer TextDraw types. SELECTIVE point-renderer:
// worldCopyMercX already surfaced via point-feature-packer — export only its own symbols.
export * from './render-loop-helpers'
export { PointRenderer, pointUniformBytes, pointWorldCopies } from './render/point-renderer'
export * from './render/resolved-show'
export * from './render/viewport-mode-controller'
export * from './text/sdf/glyph-atlas-gpu'
export * from './text/text-renderer-types'
// SELECTIVE: TextDraw collides with text-renderer-types above.
export { TextRenderer, packUniformsForTesting } from './text/text-renderer'
// Bucket-scheduler (VTR bucket classifier: classifyVectorTileShows / groupOpaqueBySource /
// planFrameSchedule) + text-stage-diagnostics (bounded label observability).
export * from './render/bucket-scheduler'
export * from './text/text-stage-diagnostics'
// TextStage — the label-pipeline orchestrator (resolve → layout → collision → raster → atlas).
// SELECTIVE: its back-compat re-exports (resolveTypography / wrapForTesting / layoutCacheEntryValid
// / mlVerticalLayout / verticalLayoutForTesting / composeFontKey) resolve via their real homes above.
export { TextStage } from './text/text-stage'
// Camera cluster (relocated from @xgis/engine, #781 3b): Camera state machine,
// view-matrix builders, globe-anchor / unproject interaction geo, world-copies.
export * from './camera'
// XGISMap facade guts: controller / source / layer / interpreter / event / show / map-type modules.
export * from './auto-resize'
export * from './stats'
export * from './camera-controller'
export * from './controller'
export * from './feature-update-queue'
export * from './interpreter'
export * from './layer'
export * from './show-source-maps'
export * from './geojson-polar-cap-show'
export * from './synthetic-earth-surface-show'
export * from './map-types'
export * from './event-dispatcher'
export * from './map-event-bus'
export * from './interaction-controller'
export * from './map-geo-helpers'
export * from './source-manager'
// The map.ts 16-file atomic SCC (Step-7 render-loop CUT + Step-8 map.ts move): map + render-loop
// + diagnostics + render/{render-node,scene-view} + render/passes/** (background / opaque / oit /
// translucent / points / label / heatmap / overdraw-compose + pass / pass-hosts / pass-chain).
// Internals stay PRIVATE — SELECTIVE export of only what a staying shell/test imports cross-package:
//   - XGISMap + its load-path helpers extractConversionNotes / logConversionNotes. Blanket
//     `export * from './map'` is AVOIDED: map re-exports the map-types surface already surfaced
//     via './map-types' — a blanket re-export would be an ambiguous duplicate.
//   - backgroundPass / BackgroundPassHost / SceneView / FrameContext / lineLabelDeduped /
//     lineIconIsIconOnly — consumed by background-opacity-wiring.test.ts / icon-cross-tile-dedup.test.ts.
export { XGISMap, extractConversionNotes, logConversionNotes } from './map'
export { backgroundPass } from './render/passes/background-pass'
export type { BackgroundPassHost } from './render/passes/pass-hosts'
export type { SceneView } from './render/scene-view'
// #781 — per-frame render-loop state (relocated from @xgis/rhi-webgpu; carries the geo Camera).
export type { FrameContext } from './render/frame-context'
// #929 C — the opaque projection token moved here from @xgis/engine (content
// mints/decodes it; FrameContext only transports it).
export * from './render/projection-token'
export { lineLabelDeduped, lineIconIsIconOnly } from './render/passes/label-pass'
