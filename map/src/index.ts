// @xgis/map public barrel. Re-exports content extracted from runtime/src/engine.
// During the incremental P3 Step 6 extraction this also surfaces internal symbols that
// still-in-runtime content imports cross-package; those are pruned to the public API in Step 8.
export * from './shaders/dsl'
// Builders the dsl/ index intentionally keeps private to dsl-internal consumers but which
// still-in-runtime content deep-imports during the incremental extraction (pruned in Step 8).
export * from './shaders/dsl/polygon'
export * from './shaders/dsl/oit-compose'
export * from './shaders/dsl/overdraw-fs'
export * from './render/globe-eye-uniform'
// P3 Batch B — vertex/uniform formats + materials (deep-imported by still-in-runtime
// renderers/passes/pipeline-factory; pruned to the public API in Step 8).
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
// P3 Batch C — paint/frame/VTR leaf content (pruned to the public API in Step 8).
export * from './render/frame-projection-uniform'
export * from './render/line-pattern'
export * from './render/vector-tile-renderer-types'
export * from './render/vector-tile-renderer-helpers'
export * from './graticule'
// P3 Batch D — point-renderer-types + text leaf content (pruned to public API in Step 8).
export * from './render/point-renderer-types'
// Stateless point-packing authority (#722 S0) — stride-24 feat_data assembly +
// world-copy fan-out + translucent depth-sort, consumed by point-renderer.
export * from './render/point-feature-packer'
export * from './text/sdf-shape'
export * from './text/text-collision'
export * from './text/text-resolver'
export * from './text/sdf/atlas-state'
export * from './text/sdf/distance-transform'
export * from './text/sdf/pbf/varint'
// P3 Batch E — content-side boundary utils (profiling / diagnostics / vertex crosscheck).
export * from './__profile__/perf-marks'
export * from './__profile__/alloc-counter'
export * from './diagnostics/render-trace'
export * from './render/__vertex-format-crosscheck'
export * from './debug-flags'
// P3 Phase-2 Batch M1 — data-driven / heatmap color-ramp GPU texture builder (content).
export * from './color-ramp'
// P3 Phase-2 Batch B1 — leaf content machinery (compose/blur pipeline builders, compute-kernel
// feat_data packer, label feature source, tile-selection cache) deep-imported cross-package by
// still-in-runtime VTR / pipeline-factory (pruned to the public API in Step 8).
export * from './render/compose-pipelines'
export * from './render/compute-feature-packer'
export * from './render/label-feature-source'
export * from './render/tile-selection-cache'
// P3 Phase-2 Batch B1b — dependency-leaf render/text/sprite content machinery (renderers +
// gpu-tile-store + uniform-ring + sprite-atlas-host + glyph-rasterizer + glyphs.proto decoder +
// projection WGSL re-export shim) deep-imported cross-package by still-in-runtime VTR / map.ts /
// text-stage / sprite pipeline (pruned to the public API in Step 8).
export * from './render/heatmap-renderer'
export * from './render/raster-renderer'
export * from './render/gpu-tile-store'
export * from './render/uniform-ring'
export * from './sprite/sprite-atlas-host'
export * from './text/sdf/glyph-rasterizer'
export * from './text/sdf/pbf/glyphs-proto'
export * from './shaders/projection'
// line-renderer re-exports the line-pattern public surface (lineUniformSize / LINE_CAP_* /
// packLineLayerUniform / DashConfig / …) which the barrel already star-exports via
// './render/line-pattern' — a blanket re-export would be an ambiguous duplicate. Export only
// line-renderer's OWN symbols.
export { LineRenderer, buildLineSegments, LINE_SEGMENT_STRIDE_F32, LINE_SEGMENT_STRIDE_BYTES } from './render/line-renderer'
// P3 Phase-2 Batch B1c — remaining B1 dependency-leaf content (feature paint/filter helpers,
// tile-classification decision logic, extruded polygon-mesh builder, render-cache versioning /
// bundle+structural cache-key hashing, dirty-domain tracker) deep-imported cross-package by
// still-in-runtime VTR / map.ts / prefetch-scheduler / passes (pruned to the public API in Step 8).
export * from './feature-helpers'
export * from './tile-decision'
export * from './core/polygon-mesh'
export * from './_cache/versioned-state'
export * from './_cache/bundle-cache-key'
export * from './_cache/structural-key'
export * from './state/dirty'
// P3 Phase-2 Batch B2 — render/sprite/text content leaves unlocked by B1 (each depended only on a
// now-migrated B1 leaf): graticule overlay renderer, speculative tile prefetch scheduler, per-tile
// compute-pass resources, GPU tile-upload coordinator, sprite-atlas GPU texture binder, PBF glyph
// provider interface + PBF→slot bridge — deep-imported cross-package by still-in-runtime renderer.ts /
// VTR / compute-layer-handle / icon pipeline / pbf-rasterizer (pruned to the public API in Step 8).
export * from './render/graticule-renderer'
export * from './render/prefetch-scheduler'
export * from './render/tile-compute-resources'
export * from './render/upload-coordinator'
export * from './sprite/sprite-atlas-gpu'
export * from './text/sdf/pbf/glyph-provider'
export * from './text/sdf/pbf/pbf-to-slot'
// P3 Phase-2 Batch B3 — render/sprite/text content leaves unlocked by B1+B2 (each depended only on a
// now-migrated B1/B2 leaf): per-layer compute lifecycle handle, standalone sprite-icon GPU pipeline,
// PBF glyph rasterizer chain + HTTP range cache + inline (air-gapped) glyph provider — deep-imported
// cross-package by still-in-runtime compute-layer-registry / feature-data-binder / icon-stage /
// text-stage (pruned to the public API in Step 8).
export * from './render/compute-layer-handle'
export * from './sprite/icon-renderer'
export * from './text/sdf/pbf-rasterizer'
export * from './text/sdf/pbf/glyph-pbf-cache'
export * from './text/sdf/pbf/inline-glyph-provider'
