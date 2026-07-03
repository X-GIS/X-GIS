import earcut from 'earcut'
import { interpolateGreatCircle } from '@xgis/compiler/tiler/geodesic'
import { MERCATOR_LAT_LIMIT } from '@xgis/engine'
import { assertIngestBudget } from '@xgis/shared'
import {
  subdivideRing,
  splitWidePolygon,
  splitLineAtAntiMeridian,
  MAX_EDGE_DEGREES,
  MAX_TRI_DEGREES,
} from './geojson-helpers'
import type {
  GeoJSONFeatureCollection,
  MeshData,
  FeatureRange,
  LineMeshData,
} from './geojson-types'

// Re-export the public type + projection-helper surface so every prior import
// path (../loader/geojson) keeps resolving after the types / pure helpers were
// split into geojson-types.ts and geojson-helpers.ts.
export type {
  GeoJSONFeatureCollection,
  GeoJSONFeature,
  GeoJSONGeometry,
  MeshData,
  LineMeshData,
} from './geojson-types'
export { lonLatToMercator } from './geojson-helpers'

// ═══ GeoJSON → GPU Mesh ═══

export function loadGeoJSON(data: GeoJSONFeatureCollection): {
  polygons: MeshData
  lines: LineMeshData
} {
  // Defense-in-depth DoS guard for the PUBLIC tessellator entry point.
  // In-repo callers budget upstream, but a direct host caller can hand an
  // attacker-controlled FeatureCollection straight here; cap the feature /
  // vertex count before tessellation allocates. No-op on a non-array
  // `features` — shape errors fall through to the loop's own handling.
  assertIngestBudget((data as { features?: unknown })?.features, 'loadGeoJSON')

  const polyVertices: number[] = []
  const polyIndices: number[] = []
  const polyFeatures: FeatureRange[] = []

  const lineVertices: number[] = []
  const lineIndices: number[] = []
  const lineFeatures: FeatureRange[] = []

  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity

  for (const feature of data.features) {
    const geom = feature.geometry
    if (!geom) continue // skip features with null geometry

    if (geom.type === 'Polygon') {
      tessellatePolygon(
        geom.coordinates,
        feature.properties,
        polyVertices,
        polyIndices,
        polyFeatures,
      )
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        tessellatePolygon(polygon, feature.properties, polyVertices, polyIndices, polyFeatures)
      }
    } else if (geom.type === 'LineString') {
      tessellateLineString(
        geom.coordinates,
        feature.properties,
        lineVertices,
        lineIndices,
        lineFeatures,
      )
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        tessellateLineString(line, feature.properties, lineVertices, lineIndices, lineFeatures)
      }
    } else if (geom.type === 'GeometryCollection') {
      // GeoJSON spec allows a feature whose geometry is a
      // GeometryCollection — flatten sub-geometries and recurse on
      // each. Pre-fix the four `else if` arms above silently dropped
      // every GeometryCollection feature; OSM extracts that bundle
      // a polygon + label-anchor point per landuse feature would
      // never render the polygon side.
      // Reads the typed shape with explicit narrowing so the inner
      // recursion doesn't drag the broader Geometry union in.
      const collection = geom as { geometries?: unknown[] }
      for (const sub of collection.geometries ?? []) {
        if (!sub || typeof sub !== 'object') continue
        const subGeom = sub as { type?: string; coordinates?: unknown }
        if (subGeom.type === 'Polygon') {
          tessellatePolygon(
            subGeom.coordinates as never,
            feature.properties,
            polyVertices,
            polyIndices,
            polyFeatures,
          )
        } else if (subGeom.type === 'MultiPolygon') {
          for (const polygon of subGeom.coordinates as never[]) {
            tessellatePolygon(polygon, feature.properties, polyVertices, polyIndices, polyFeatures)
          }
        } else if (subGeom.type === 'LineString') {
          tessellateLineString(
            subGeom.coordinates as never,
            feature.properties,
            lineVertices,
            lineIndices,
            lineFeatures,
          )
        } else if (subGeom.type === 'MultiLineString') {
          for (const line of subGeom.coordinates as never[]) {
            tessellateLineString(line, feature.properties, lineVertices, lineIndices, lineFeatures)
          }
        }
        // Nested GeometryCollections (spec-permitted) are NOT recursed
        // — Mapbox / MapLibre flatten one level only. Document the
        // limit so callers needing deeper nesting pre-flatten.
      }
    }
  }

  // Compute bounds (lon/lat degrees, stride 3: lon,lat,feat_id).
  // Math.min/max propagate NaN — if ANY coord is NaN (malformed
  // upstream geometry), the bounds collapse to NaN and downstream
  // tile-coverage / fit-to-bounds logic that compares against them
  // silently fails. Skip non-finite coords so the bounds stay
  // computable from the valid subset.
  for (let i = 0; i < polyVertices.length; i += 3) {
    const lon = polyVertices[i],
      lat = polyVertices[i + 1]
    if (Number.isFinite(lon) && lon < 500) {
      minLon = Math.min(minLon, lon)
      maxLon = Math.max(maxLon, lon)
    }
    if (Number.isFinite(lat)) {
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
    }
  }
  for (let i = 0; i < lineVertices.length; i += 4) {
    const lon = lineVertices[i],
      lat = lineVertices[i + 1]
    if (Number.isFinite(lon)) {
      minLon = Math.min(minLon, lon)
      maxLon = Math.max(maxLon, lon)
    }
    if (Number.isFinite(lat)) {
      minLat = Math.min(minLat, lat)
      maxLat = Math.max(maxLat, lat)
    }
  }

  const bounds: [number, number, number, number] = [minLon, minLat, maxLon, maxLat]

  return {
    polygons: {
      vertices: new Float32Array(polyVertices),
      indices: new Uint32Array(polyIndices),
      features: polyFeatures,
      bounds,
    },
    lines: {
      vertices: new Float32Array(lineVertices),
      indices: new Uint32Array(lineIndices),
      features: lineFeatures,
      bounds,
    },
  }
}

// ═══ Polygon tessellation ═══

function tessellatePolygon(
  rings: number[][][],
  properties: Record<string, unknown>,
  outVertices: number[],
  outIndices: number[],
  outFeatures: FeatureRange[],
): void {
  // Split wide polygons at 90° intervals to prevent earcut from creating
  // internal triangle edges that span the globe (visible as diagonal artifacts)
  const parts = splitWidePolygon(rings)
  for (const partRings of parts) {
    tessellatePolygonPart(partRings, properties, outVertices, outIndices, outFeatures)
  }
}

function tessellatePolygonPart(
  rings: number[][][],
  properties: Record<string, unknown>,
  outVertices: number[],
  outIndices: number[],
  outFeatures: FeatureRange[],
): void {
  const STRIDE = 3 // lon, lat, feat_id
  const baseVertex = outVertices.length / STRIDE
  const baseIndex = outIndices.length
  const featureId = outFeatures.length // 0-based feature index

  const flatCoords: number[] = []
  const holeIndices: number[] = []

  for (let r = 0; r < rings.length; r++) {
    if (r > 0) {
      holeIndices.push(flatCoords.length / 2)
    }

    let ring = subdivideRing(rings[r])

    for (const coord of ring) {
      // Clamp latitude to Mercator limit — Antarctica at -90° → -MERCATOR_LAT_LIMIT
      flatCoords.push(
        coord[0],
        Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, coord[1])),
      )
    }
  }

  // Triangulate with earcut (uses 2D flat coords)
  const earcutIndices = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : undefined)

  // Post-earcut subdivision (internal: still 2D for math)
  const finalVertices: number[] = [...flatCoords]
  const finalIndices: number[] = []
  const vertexMap = new Map<string, number>()

  function snapKey(lon: number, lat: number): string {
    return `${(lon * 1e6) | 0},${(lat * 1e6) | 0}`
  }

  for (let i = 0; i < flatCoords.length; i += 2) {
    vertexMap.set(snapKey(flatCoords[i], flatCoords[i + 1]), i / 2)
  }

  function getOrAddVertex(lon: number, lat: number): number {
    const key = snapKey(lon, lat)
    let idx = vertexMap.get(key)
    if (idx !== undefined) return idx
    idx = finalVertices.length / 2
    finalVertices.push(lon, lat)
    vertexMap.set(key, idx)
    return idx
  }

  function subdivideTri(i0: number, i1: number, i2: number, depth: number): void {
    const x0 = finalVertices[i0 * 2],
      y0 = finalVertices[i0 * 2 + 1]
    const x1 = finalVertices[i1 * 2],
      y1 = finalVertices[i1 * 2 + 1]
    const x2 = finalVertices[i2 * 2],
      y2 = finalVertices[i2 * 2 + 1]

    const d01 = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    const d12 = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))
    const d20 = Math.max(Math.abs(x0 - x2), Math.abs(y0 - y2))
    const maxEdge = Math.max(d01, d12, d20)

    if (maxEdge <= MAX_TRI_DEGREES || depth >= 5) {
      finalIndices.push(i0, i1, i2)
      return
    }

    const [m01x, m01y] = interpolateGreatCircle(x0, y0, x1, y1, 0.5)
    const [m12x, m12y] = interpolateGreatCircle(x1, y1, x2, y2, 0.5)
    const [m20x, m20y] = interpolateGreatCircle(x2, y2, x0, y0, 0.5)
    const m01 = getOrAddVertex(m01x, m01y)
    const m12 = getOrAddVertex(m12x, m12y)
    const m20 = getOrAddVertex(m20x, m20y)

    subdivideTri(i0, m01, m20, depth + 1)
    subdivideTri(m01, i1, m12, depth + 1)
    subdivideTri(m20, m12, i2, depth + 1)
    subdivideTri(m01, m12, m20, depth + 1)
  }

  for (let t = 0; t < earcutIndices.length; t += 3) {
    subdivideTri(earcutIndices[t], earcutIndices[t + 1], earcutIndices[t + 2], 0)
  }

  // Emit final vertices with feat_id (stride 3: lon, lat, feat_id)
  for (let i = 0; i < finalVertices.length; i += 2) {
    outVertices.push(finalVertices[i], finalVertices[i + 1], featureId)
  }
  for (const idx of finalIndices) {
    outIndices.push(baseVertex + idx)
  }

  outFeatures.push({
    indexOffset: baseIndex,
    indexCount: finalIndices.length,
    properties,
  })
}

// ═══ LineString tessellation ═══

function tessellateLineString(
  coordinates: number[][],
  properties: Record<string, unknown>,
  outVertices: number[],
  outIndices: number[],
  outFeatures: FeatureRange[],
): void {
  // Split at the anti-meridian (±180°) so each piece stays in a continuous
  // coordinate space. Without this, a line from lon=170 to lon=-170 would
  // produce a 340° segment across the entire map instead of a 20° segment
  // crossing the date line.
  const pieces = splitLineAtAntiMeridian(coordinates)
  for (const piece of pieces) {
    tessellateLineStringPiece(piece, properties, outVertices, outIndices, outFeatures)
  }
}

function tessellateLineStringPiece(
  coordinates: number[][],
  properties: Record<string, unknown>,
  outVertices: number[],
  outIndices: number[],
  outFeatures: FeatureRange[],
): void {
  const STRIDE = 4
  const baseVertex = outVertices.length / STRIDE
  const baseIndex = outIndices.length
  const featureId = outFeatures.length

  const subdivided: number[][] = []
  for (let i = 0; i < coordinates.length; i++) {
    subdivided.push(coordinates[i])
    if (i < coordinates.length - 1) {
      const curr = coordinates[i]
      const next = coordinates[i + 1]
      const dlon = Math.abs(next[0] - curr[0])
      const dlat = Math.abs(next[1] - curr[1])
      const maxDeg = Math.max(dlon, dlat)
      if (maxDeg > MAX_EDGE_DEGREES) {
        const segments = Math.ceil(maxDeg / MAX_EDGE_DEGREES)
        for (let s = 1; s < segments; s++) {
          const t = s / segments
          subdivided.push(interpolateGreatCircle(curr[0], curr[1], next[0], next[1], t))
        }
      }
    }
  }

  // Compute f64 global arc-length per vertex (Mercator meters)
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  const clampLat = (v: number) => Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, v))
  let arc = 0
  let prevMx = 0,
    prevMy = 0
  for (let i = 0; i < subdivided.length; i++) {
    const c = subdivided[i]
    const mx = c[0] * DEG2RAD * R
    const my = Math.log(Math.tan(Math.PI / 4 + (clampLat(c[1]) * DEG2RAD) / 2)) * R
    if (i > 0) {
      const dx = mx - prevMx,
        dy = my - prevMy
      arc += Math.sqrt(dx * dx + dy * dy)
    }
    outVertices.push(c[0], c[1], featureId, arc)
    prevMx = mx
    prevMy = my
  }

  for (let i = 0; i < subdivided.length - 1; i++) {
    outIndices.push(baseVertex + i, baseVertex + i + 1)
  }

  outFeatures.push({
    indexOffset: baseIndex,
    indexCount: (subdivided.length - 1) * 2,
    properties,
  })
}
