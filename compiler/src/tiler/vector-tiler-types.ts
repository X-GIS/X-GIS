// ═══ Vector Tiler: shared types ═══
// Type/interface declarations extracted from vector-tiler.ts so the tiling
// pipeline module stays focused on logic. Public types are re-exported from
// vector-tiler.ts to keep the module's public surface unchanged.

import type { GeoJSONFeature } from './geojson-types'

export interface CompiledTileSet {
  levels: TileLevel[]
  bounds: [number, number, number, number]
  featureCount: number
  propertyTable: PropertyTable
}

export type PropertyFieldType = 'f64' | 'string' | 'bool'

export interface PropertyTable {
  fieldNames: string[]
  fieldTypes: PropertyFieldType[]
  /** values[featureIndex][fieldIndex] */
  values: (number | string | boolean | null)[][]
}

export interface TileLevel {
  zoom: number
  tiles: Map<number, CompiledTile>
}

export interface CompiledTile {
  z: number
  x: number
  y: number
  tileWest: number   // tile origin longitude (f64 precision in JS)
  tileSouth: number  // tile origin latitude (f64 precision in JS)
  /** Polygon fill vertices as DSFUN stride-5 pairs:
   *  [mx_h, my_h, mx_l, my_l, feat_id] in tile-local Mercator meters.
   *  mx_h + mx_l reconstructs an f64-equivalent coordinate — the shader
   *  cancels tile-origin magnitude with (pos_h - cam_h) + (pos_l - cam_l)
   *  so precision survives into camera-relative space. */
  vertices: Float32Array
  indices: Uint32Array
  /** Line vertices as DSFUN stride-6 pairs:
   *  [mx_h, my_h, mx_l, my_l, feat_id, arc_start]. arc_start is global
   *  f64-accumulated Mercator-meter arc length (precomputed in tiler). */
  lineVertices: Float32Array
  lineIndices: Uint32Array
  /** @deprecated Always emitted empty since the BFS outline path was
   *  retired. Polygon outlines now travel through `outlineVertices` +
   *  `outlineLineIndices` (DSFUN stride-10 with global arc_start),
   *  matching the line-feature shape so dash phase + pattern arc are
   *  continuous across tile clips. Field kept on the interface only to
   *  preserve the SerializedTile / TileData ABI; will be removed in a
   *  future version. */
  outlineIndices: Uint32Array
  /** Polygon outline vertices in DSFUN stride-10 (same layout as
   *  `lineVertices`). Each polygon ring is augmented with global
   *  Mercator-meter arc_start at tile-compile time and clipped via
   *  `clipLineToRect` so dash phase + pattern arc remain continuous
   *  across tile boundaries — the fix that retired the per-tile BFS
   *  arc walker that used to reset the phase at every tile clip. */
  outlineVertices: Float32Array
  /** Vertex-pair indices into `outlineVertices` (line segment list). */
  outlineLineIndices: Uint32Array
  featureCount: number
  fullCover?: boolean
  fullCoverFeatureId?: number
  /** Original clipped polygon rings for runtime sub-tiling */
  polygons?: { rings: number[][][]; featId: number }[]
  /** Point vertices as DSFUN stride-5 pairs (same layout as polygon). */
  pointVertices?: Float32Array
}

/** Geometry Part: per-polygon/per-line with tight bbox. */
export interface GeometryPart {
  type: 'polygon' | 'line' | 'point'
  rings?: number[][][]
  coords?: number[][]
  point?: number[]           // [lon, lat] for Point geometry
  featureIndex: number
  minLon: number; minLat: number; maxLon: number; maxLat: number
}

/** Resolver mapping a feature + its index to a stable u32 id used as
 *  `featureIndex` inside the tiler and as the shader-visible feature
 *  id. Default (legacy) behavior: array index. External-injection
 *  callers pass a resolver that reads `feature.id` / `properties.id`
 *  so ids survive retiles. */
export type FeatureIdResolver = (feature: GeoJSONFeature, index: number) => number

export interface TilerOptions {
  minZoom?: number
  maxZoom?: number
  /** Called after each zoom level is compiled — enables progressive rendering */
  onLevel?: (level: TileLevel, bounds: [number, number, number, number], propertyTable: PropertyTable) => void
  /** If true, yield to the event loop between zoom levels (browser only) */
  async?: boolean
  /** Optional resolver for stable feature ids. Defaults to array index. */
  idResolver?: FeatureIdResolver
}
