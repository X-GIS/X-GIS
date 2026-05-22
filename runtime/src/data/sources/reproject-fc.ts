import proj4 from 'proj4'
import { normalizeEPSG, resolveEPSG } from './epsg-defs'
import type {
  GeoJSONFeatureCollection,
  GeoJSONFeature,
  GeoJSONGeometry,
} from '../../loader/geojson'

// ═══ Input-data EPSG → WGS84 reprojection ═══
//
// The display pipeline (LL → MM → DLM → SP) is fed lon/lat in EPSG:4326.
// Input GeoJSON can arrive in any authority code, so at the single point
// where a FeatureCollection is registered the runtime reprojects every
// coordinate pair once from the declared source CRS to WGS84 lon/lat. See
// the EPSG input-reprojection plan (Steps 5 / 7, AC8). Display projection
// (the 7 screen systems) is untouched — this is an input-side transform.
//
// proj4 transform is the same forward path the AC0 spike validated against
// pyproj (≤ 3.7 nm divergence at EPSG:3857 meters). Definitions for codes
// proj4 does not bundle are registered by `resolveEPSG` (epsg-defs.ts).
//
// CLONE, NOT MUTATE: this returns a NEW FeatureCollection with transformed
// coordinates and leaves the input untouched. Callers (e.g. setSourceData,
// host-pushed data, cached inline GeoJSON) may share the same object
// reference, so transforming in place would corrupt other holders and make
// the operation non-idempotent. Geometry-less features and the `properties`
// / `id` members are carried through by reference (they are not coordinate
// data). The EPSG:4326 → EPSG:4326 no-op short-circuit returns the input
// reference unchanged (no allocation).

/** A proj4 forward transform from `fromEPSG` to WGS84 (EPSG:4326). */
type Transform = (xy: number[]) => number[]

/** Transform a single `[x, y, ...]` position, preserving any trailing
 *  ordinates (e.g. elevation `z` / `m`). proj4 returns `[lon, lat]`; we
 *  splice the reprojected pair back over the original to keep extras. */
function transformPosition(pos: number[], tf: Transform): number[] {
  // Defensive: a degenerate position with < 2 ordinates can't be
  // reprojected — pass it through unchanged rather than throwing.
  if (pos.length < 2) return pos.slice()
  const [lon, lat] = tf([pos[0]!, pos[1]!])
  if (pos.length === 2) return [lon!, lat!]
  const out = pos.slice()
  out[0] = lon!
  out[1] = lat!
  return out
}

/** Recursively reproject a coordinate array of arbitrary nesting depth
 *  (position / line / ring / polygon-list). The leaf is detected when the
 *  first element is a number (a position). */
function transformCoords(coords: unknown, tf: Transform): unknown {
  if (!Array.isArray(coords)) return coords
  if (typeof coords[0] === 'number') {
    return transformPosition(coords as number[], tf)
  }
  return coords.map((c) => transformCoords(c, tf))
}

/** Reproject one geometry of any GeoJSON type, recursing into
 *  GeometryCollection. Returns a new geometry; `null` passes through. */
function transformGeometry(
  geom: GeoJSONGeometry | null,
  tf: Transform,
): GeoJSONGeometry | null {
  if (geom === null) return null
  if (geom.type === 'GeometryCollection') {
    return {
      type: 'GeometryCollection',
      geometries: geom.geometries.map((g) => transformGeometry(g, tf)!),
    }
  }
  return {
    type: geom.type,
    coordinates: transformCoords(geom.coordinates, tf),
  } as GeoJSONGeometry
}

/**
 * Reproject every coordinate in a FeatureCollection from `fromEPSG` to
 * WGS84 lon/lat (EPSG:4326), returning a NEW transformed collection.
 *
 * Handles all RFC 7946 geometry types — Point, MultiPoint, LineString,
 * MultiLineString, Polygon, MultiPolygon, and GeometryCollection.
 *
 * @param fc       the source FeatureCollection (left unmodified).
 * @param fromEPSG the declared input CRS (e.g. `"EPSG:5179"`, `"5179"`, or
 *                 `5179`). When this normalizes to `EPSG:4326` the function
 *                 is a no-op and returns `fc` unchanged.
 * @returns a reprojected FeatureCollection (or `fc` itself for the 4326
 *          no-op).
 * @throws if `fromEPSG` is malformed or not a registered EPSG code
 *         (propagated from `resolveEPSG`).
 */
export function reprojectFeatureCollection(
  fc: GeoJSONFeatureCollection,
  fromEPSG: string | number,
): GeoJSONFeatureCollection {
  // EPSG:4326 → EPSG:4326 is a no-op: the data is already in the pipeline's
  // input CRS. `normalizeEPSG` validates the spelling but does not require
  // registration, so a "4326" / "EPSG:4326" / 4326 input all short-circuit.
  if (normalizeEPSG(fromEPSG) === 'EPSG:4326') return fc

  // resolveEPSG registers any bundled def + throws on unregistered codes.
  const from = resolveEPSG(fromEPSG)
  const tf: Transform = (xy) => proj4(from, 'EPSG:4326', xy)

  const features: GeoJSONFeature[] = fc.features.map((feat) => ({
    type: 'Feature',
    ...(feat.id !== undefined ? { id: feat.id } : {}),
    geometry: transformGeometry(feat.geometry, tf),
    properties: feat.properties,
  }))

  return { type: 'FeatureCollection', features }
}
