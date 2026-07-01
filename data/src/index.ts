// @xgis/data public barrel. The tile data + loader layer (tile selection / catalog /
// types / SSE loading + the geometry helpers those need), extracted from runtime/src so
// @xgis/map (rendering) depends on it rather than owning it (SRP: data ≠ rendering).
//
// geojson data model (loader): loadGeoJSON + the mesh/feature types + lonLatToMercator.
// The barrel re-exports its geojson-types + geojson-helpers internals.
export * from './geojson'
// Stable feature-id resolver + typed-array point-patch → FeatureCollection ingest
// (fnv1a32 / toU32Id / PointPatch / pointPatchToFeatureCollection). Pure data logic
// that was misplaced under runtime/src/engine; consumed by setSourceData / picking.
export * from './id-resolver'
// Tile data-model types cluster: the TileSource contract + backend sink/result, the
// per-tile TileData (DSFUN strides, cache budget) + VirtualCatalog, and the tile-select
// coordinate types. The catalog / selection / source backends (still in runtime/src/data)
// consume these cross-package until they too relocate here.
export * from './tile-source'
export * from './tile-types'
export * from './tile-select-types'
// Tile data-layer logic leaves (F4): pure geometry/budget/eviction/cache helpers + the
// filter/extrude expression evaluators + polar-cap mesh synth/detect. Depend only on
// @xgis/compiler + the already-relocated data types; the still-in-runtime catalog /
// selection / source backends consume them cross-package until they relocate too.
export * from './tile-catalog-helpers'
export * from './tile-compile-budget'
export * from './tile-data-cache'
export * from './tile-eviction-policy'
export * from './tile-select-helpers'
export * from './polar-cap-synth'
export * from './polar-cap-detect'
export * from './eval/filter-eval'
export * from './eval/extrude-eval'
