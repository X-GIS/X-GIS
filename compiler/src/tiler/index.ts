export {
  TILE_FLAG_FULL_COVER,
  type XGVTIndex,
  type XGVTHeader,
  type TileIndexEntry,
} from './tile-format'
export {
  tileKey,
  tileKeyUnpack,
  tileKeyParent,
  tileKeyChildren,
  compileGeoJSONToTiles,
  compileGeoJSONToTilesAsync,
  compileSingleTile,
  decomposeFeatures,
  augmentRingWithArc,
  tessellateLineToArrays,
  extractNonSyntheticArcs,
  makeSameBoundarySidePredicateMerc,
  type GeometryPart,
  type PropertyTable,
  type PropertyFieldType,
  type CompiledTileSet,
  type CompiledTile,
  type TileLevel,
  type TilerOptions,
  type FeatureIdResolver,
} from './vector-tiler'
export {
  lonLatToMercF64,
  splitF64,
  packDSFUNLineVertices,
  packECEFPolygonVertices,
  packECEFPointFeatures,
  packECEFLineSegments,
  tileEcefCenterFromMerc,
} from './ecef-packing'
export { clipPolygonToRect, clipPolygonToRectV2, clipLineToRect } from './clip'
export { geojsonvt, GeoJSONVT, DEFAULT_OPTIONS as GEOJSONVT_DEFAULT_OPTIONS } from './geojsonvt'
export { encodeMVT, type MVTLayerInput, type EncodeOptions } from './geojsonvt/encode-mvt'
export type { GeoJSONVTOptions, TransformedTile, TransformedTileFeature } from './geojsonvt/types'
export {
  simplify,
  simplifyPolygon,
  simplifyLine,
  toleranceForZoom,
  mercatorToleranceForZoom,
} from './simplify'
export { interpolateGreatCircle, haversineDistance } from './geodesic'
export { type RingPolygon } from './encoding'
export { POLYGON_FILL_FORMAT, POLYGON_EXTRUDED_FORMAT } from './polygon-vertex-format'
// The single-source vertex-format machinery relocated to @xgis/rhi (the
// []-root) in #929 B3 so backend adapters can consume it without importing the
// compiler; re-exported here so the compiler's existing public surface is
// unchanged for downstream (@xgis/map, @xgis/data) importers.
export {
  buildFormat,
  field as vertexField,
  VB_FORMAT_BYTES,
  type VbFormat,
  type WgslType,
  type VertexField,
  type ResolvedField,
  type VertexFormat,
} from '@xgis/rhi'
export {
  dequantVertex,
  dequantVertexF32,
  mulMat4Vec4F32,
  type QuantizedDecode,
} from './dequant-mirror'
export type { GeoJSONFeature, GeoJSONGeometry, GeoJSONFeatureCollection } from './geojson-types'
