// Type declarations extracted from geojson.ts.
//
// Public types (GeoJSONFeatureCollection / GeoJSONFeature / GeoJSONGeometry /
// MeshData / LineMeshData) are re-exported from geojson.ts to preserve every
// prior import path. FeatureRange is imported directly by the loader and the
// helper module that share the GPU-mesh emit shape.

// ═══ GeoJSON Types (minimal) ═══

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJSONFeature[]
}

export interface GeoJSONFeature {
  type: 'Feature'
  /** RFC 7946 §3.2 — Feature objects MAY include an `id` member
   *  (string or number). resolveIdResolver consumes it as the
   *  primary identifier in 'feature-id-fallback' mode. */
  id?: string | number
  /** RFC 7946 §3.2 — `geometry` may be JSON `null` for an
   *  "unlocated" Feature. loadGeoJSON's main loop skips null-geometry
   *  features defensively (geojson.ts:302); the type now matches the
   *  spec so callers don't need `as unknown as null` casts. */
  geometry: GeoJSONGeometry | null
  properties: Record<string, unknown>
}

export type GeoJSONGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'MultiPoint'; coordinates: number[][] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  /** RFC 7946 §3.1.8 — bundles heterogeneous sub-geometries under one
   *  feature. loadGeoJSON (iter 452) flattens one level. Nested
   *  GeometryCollections are NOT recursed. */
  | { type: 'GeometryCollection'; geometries: GeoJSONGeometry[] }

// ═══ GPU-ready mesh data ═══

export interface MeshData {
  vertices: Float32Array  // [lon, lat, feat_id, lon, lat, feat_id, ...] in degrees (3 floats/vertex)
  indices: Uint32Array
  features: FeatureRange[]
  bounds: [number, number, number, number] // [minLon, minLat, maxLon, maxLat]
}

export interface FeatureRange {
  indexOffset: number
  indexCount: number
  properties: Record<string, unknown>
}

export interface LineMeshData {
  vertices: Float32Array
  indices: Uint32Array
  features: FeatureRange[]
  bounds: [number, number, number, number]
}
