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
