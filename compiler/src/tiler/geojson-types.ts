// GeoJSON type definitions for the compiler tiler.
// Duplicated from runtime to avoid cross-package imports.

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJSONFeature[]
}

export interface GeoJSONFeature {
  type: 'Feature'
  /** RFC 7946 §3.2 — `geometry` may be JSON `null` for an "unlocated"
   *  Feature. The tiler's decompose path already runtime-skips a null
   *  geometry (decomposeFeatures / extractFirstRing in vector-tiler.ts),
   *  so the type matches the values the tiler actually receives. */
  geometry: GeoJSONGeometry | null
  properties: Record<string, unknown>
  /** Optional GeoJSON feature id (RFC 7946 §3.2). The filter-eval
   *  path exposes this via the synthetic `$featureId` prop so Mapbox
   *  `["id"]` accessor / `["filter-id-in", …]` filters can read it
   *  without the converter inventing a property name. MVT decoders
   *  populate this from the feature.id field of the .mvt protobuf;
   *  GeoJSON sources from the top-level `id` of each feature. */
  id?: string | number
}

export type GeoJSONGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'MultiPoint'; coordinates: number[][] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  // RFC 7946 §3.1.8 — a GeometryCollection carries a member list, not a
  // `coordinates` array. `geometries` is REQUIRED per the RFC; the tiler
  // demonstrably receives this variant, so the union must carry it.
  | { type: 'GeometryCollection'; geometries: GeoJSONGeometry[] }
