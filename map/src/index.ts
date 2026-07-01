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
