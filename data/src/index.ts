// @xgis/data public barrel. The tile data + loader layer (tile selection / catalog /
// types / SSE loading + the geometry helpers those need), extracted from runtime/src so
// @xgis/map (rendering) depends on it rather than owning it (SRP: data ≠ rendering).
//
// geojson data model (loader): loadGeoJSON + the mesh/feature types + lonLatToMercator.
// The barrel re-exports its geojson-types + geojson-helpers internals.
export * from './geojson'
// MVT (.pbf) tile decoder (decodeMvtTile / MvtDecodeOptions): raw Mapbox Vector
// Tile bytes → un-quantized GeoJSONFeature[]. Relocated from @xgis/compiler (#1001):
// tile decoding is data-layer work, not style compilation. Consumed by the PMTiles /
// virtual-PMTiles source backends + the mvt-worker.
export * from './mvt-decoder'
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
// Tile selection + sub-tile generation (F5): frustum/visibility tile selection + the
// raster tile loader, and the sub-tile mesh generator. Depend on @xgis/engine projection
// + the relocated data types/helpers. (tile-select's TileCoord/helper re-exports were
// dropped — the barrel surfaces those directly via tile-select-types / tile-select-helpers.)
export * from './tile-select'
export * from './sub-tile-generator'
// Line mesh geometry kernel (F6a): buildLineSegments + stride/miter constants. Pure
// (zero imports); consumed by BOTH data (tile source backends / mvt-worker build line
// meshes) and content (line-renderer), so its LCA is @xgis/data — mesh-building is data,
// consistent with geojson.ts doing earcut polygon triangulation.
export * from './line-segment-build'
// Final data cluster (F6b): the tile catalog/router, the raster-tile SSE selector, the
// PMTiles/TileJSON vector-tile loader, the per-format source backends (PMTiles / GeoJSON
// runtime / synthetic earth-surface / polar-cap / virtual), EPSG reprojection + polar-cap
// ECEF packing, and the worker pools. Top of the data layer; @xgis/map (rendering)
// consumes them via this barrel. Only PARENT modules are surfaced — pmtiles-backend
// re-exports its -types leaf and vector-tile-loader re-exports its -types/-helpers leaves,
// so adding those directly would duplicate exports (TS2308); the raw worker modules
// (geojson-compile-worker / geojson-tiling-worker / mvt-worker) stay internal.
export * from './tile-catalog'
export * from './tiles-sse'
export * from './vector-tile-loader'
export * from './sources/geojson-polar-cap-backend'
export * from './sources/geojson-runtime-backend'
export * from './sources/pmtiles-backend'
export * from './sources/synthetic-earth-surface-backend'
export * from './sources/virtual-pmtiles-backend'
export * from './sources/virtual-catalog-adapter'
export * from './sources/reproject-fc'
export * from './sources/epsg-defs'
export * from './sources/polar-cap-ecef-pack'
export * from './workers/geojson-compile-pool'
export * from './workers/geojson-tiling-pool'
export * from './workers/mvt-worker-pool'

// Globe visible-tile selection (relocated from @xgis/engine, #781).
export * from './globe-visible-tiles'

// S-100 gridded coverage — CoverageHandle + valueAt + the coverageFromGrids seam
// (ADR-0010). Read via the HDF5 reader below (or a COG reader), fed to the renderer
// through coverageFromGrids — no wire format in the middle.
export * from './coverage/format'

// S-100 (HDF5) reader (ADR-0010) — the zero-dep HDF5 subset reader + the S-100
// semantic layer (product-agnostic: S-102 bathymetry, S-104 water level, S-111
// surface currents). Moved here from @xgis/pipeline so @xgis/map reads the HDF5
// standard IN PLACE and builds a CoverageHandle via coverageFromGrids — no `.xgcov`.
export { openHdf5, Hdf5File, Hdf5Error } from './hdf5/index'
export type { Hdf5Node, AttrValue, Datatype, BandValues } from './hdf5/index'
export { readS102Coverage } from './hdf5/s102'
export type { S100Coverage, CoverageBand, Product } from './hdf5/s102'
// The runtime read-in-place path the `coverage` source consumes (replaces the
// retired `decodeCoverage(.xgcov)`): HDF5 bytes → CoverageHandle, no wire format.
export { readCoverageFromHdf5 } from './hdf5/coverage'
// The format-agnostic entry the `coverage` source + setCoverageData use: sniff the
// gridded-standard container magic → dispatch to its reader (HDF5 today; GRIB2/NetCDF
// are #1273/#1274). `readCoverageFromHdf5` stays exported as the HDF5-specific reader.
export { readCoverage, sniffCoverageContainer } from './coverage/read-coverage'
export type { CoverageContainer } from './coverage/read-coverage'
