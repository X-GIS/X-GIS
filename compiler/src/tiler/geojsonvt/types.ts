// ═══ geojson-vt types (1:1 TypeScript port of mapbox/geojson-vt 4.0.2) ═══
//
// Source: github.com/mapbox/geojson-vt (ISC license — preserved at
// compiler/src/tiler/geojsonvt/LICENSE). Ported here to avoid a
// runtime dependency while keeping the battle-tested algorithm; the
// per-function code is the JavaScript source with TypeScript types
// added. Algorithm correctness is verified by oracle tests that
// run our port and the upstream JS in parallel.

import type { GeoJSONFeature } from '../geojson-types'

/** Geometry types as encoded in tile data (MVT spec):
 *  1 = Point/MultiPoint, 2 = LineString/MultiLineString, 3 = Polygon/MultiPolygon. */
export type TileGeometryType = 1 | 2 | 3

/** Flat coordinate array used internally during tiling. Each vertex
 *  occupies 3 slots — [x, y, z] where z is the simplification
 *  importance (squared distance from line). Carries optional `size`
 *  / `start` / `end` metadata for line-metric tracking. */
export interface FlatLine extends Array<number> {
  size?: number
  start?: number
  end?: number
}

/** GeoJSON geometry types we accept on input. */
export type InputGeometryType =
  | 'Point' | 'MultiPoint'
  | 'LineString' | 'MultiLineString'
  | 'Polygon' | 'MultiPolygon'
  | 'GeometryCollection'

/** Internal projected feature — what convert() produces. */
export interface ProjectedFeature {
  id: string | number | null
  type: InputGeometryType
  /** Geometry shape depends on `type`:
   *    Point / MultiPoint / LineString → FlatLine (x,y,z,…)
   *    MultiLineString / Polygon       → FlatLine[]   (array of rings)
   *    MultiPolygon                    → FlatLine[][] (array of polygons) */
  geometry: FlatLine | FlatLine[] | FlatLine[][]
  tags: Record<string, unknown> | null
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Per-tile feature emitted by createTile(). */
export interface TileFeature {
  id?: string | number
  geometry: FlatLine | FlatLine[]
  type: TileGeometryType
  tags: Record<string, unknown> | null
}

/** Per-tile feature after transformTile() — coordinates in tile-local
 *  extent units (rounded to nearest int). */
export interface TransformedTileFeature {
  id?: string | number
  geometry: [number, number][] | [number, number][][]
  type: TileGeometryType
  tags: Record<string, unknown> | null
}

/** Mutable in-progress tile during splitTile(). */
export interface InternalTile {
  features: TileFeature[]
  numPoints: number
  numSimplified: number
  numFeatures: number
  /** Reference to the source feature list — set so drilldown can
   *  recurse from this tile if it's an indexed (non-leaf) tile. */
  source: ProjectedFeature[] | null
  x: number
  y: number
  z: number
  transformed: boolean
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface TransformedTile {
  features: TransformedTileFeature[]
  numPoints: number
  numSimplified: number
  numFeatures: number
  source: ProjectedFeature[] | null
  x: number
  y: number
  z: number
  transformed: true
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface GeoJSONVTOptions {
  /** Max zoom level the tile index will preserve geometry detail
   *  for. Tolerance at this zoom is 0 (no simplification). */
  maxZoom: number
  /** Max zoom of the pre-built index — tiles below this depth are
   *  generated eagerly. Higher zooms drill down on demand. */
  indexMaxZoom: number
  /** When a non-leaf indexed tile has fewer points than this, stop
   *  recursing — the parent tile is small enough to serve directly. */
  indexMaxPoints: number
  /** Simplification tolerance in extent units. MapLibre's
   *  convention: `cssPx * (extent / tileSize)`. Default: 0.375 css
   *  px × (8192 / 512) = 6. */
  tolerance: number
  /** Tile coordinate extent. MapLibre standard: 8192. */
  extent: number
  /** Per-side buffer in extent units to prevent line / polygon
   *  cracking at tile boundaries. MapLibre's convention: `cssPx *
   *  (extent / tileSize)`. Default: 128 css px × 16 = 2048. */
  buffer: number
  /** Whether to track line metrics (start / end fractions). */
  lineMetrics: boolean
  /** Optional property name to promote to `feature.id`. */
  promoteId: string | null
  /** Whether to auto-generate sequential feature ids. Mutually
   *  exclusive with `promoteId`. */
  generateId: boolean
  /** 0 = silent, 1 = high-level, 2 = per-tile (best left at 0 in
   *  production paths — every log is on the hot path). */
  debug: 0 | 1 | 2
}

export interface GeoJSONInput {
  type: 'FeatureCollection' | 'Feature' | 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon' | 'GeometryCollection'
  features?: GeoJSONFeature[]
  geometry?: { type: InputGeometryType; coordinates: unknown; geometries?: unknown[] }
  properties?: Record<string, unknown>
  id?: string | number
}
