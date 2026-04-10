import earcut from 'earcut'

// ═══ GeoJSON Types (minimal) ═══

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJSONFeature[]
}

export interface GeoJSONFeature {
  type: 'Feature'
  geometry: GeoJSONGeometry
  properties: Record<string, unknown>
}

export type GeoJSONGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'MultiPoint'; coordinates: number[][] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

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

// ═══ Projection helpers (CPU side, for bounds only) ═══

const EARTH_RADIUS = 6378137

export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const clampedLat = Math.max(-85.05, Math.min(85.05, lat))
  const x = lon * (Math.PI / 180) * EARTH_RADIUS
  const y = Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI / 180) / 2)) * EARTH_RADIUS
  return [x, y]
}

// ═══ Subdivision ═══
// 큰 삼각형을 세분화하여 프로젝션 곡선을 근사

const MAX_EDGE_DEGREES = 3 // 링 변 세분화 기준
const MAX_TRI_DEGREES = 2  // 삼각형 세분화 기준 (이보다 큰 변이 있으면 4분할)

/** Subdivide a ring by inserting midpoints along long edges */
function subdivideRing(ring: number[][]): number[][] {
  const result: number[][] = []

  for (let i = 0; i < ring.length; i++) {
    const curr = ring[i]
    const next = ring[(i + 1) % ring.length]
    result.push(curr)

    const dlon = Math.abs(next[0] - curr[0])
    const dlat = Math.abs(next[1] - curr[1])
    const maxDeg = Math.max(dlon, dlat)

    if (maxDeg > MAX_EDGE_DEGREES) {
      const segments = Math.ceil(maxDeg / MAX_EDGE_DEGREES)
      for (let s = 1; s < segments; s++) {
        const t = s / segments
        result.push([
          curr[0] + (next[0] - curr[0]) * t,
          curr[1] + (next[1] - curr[1]) * t,
        ])
      }
    }
  }

  return result
}

// ═══ Anti-meridian handling ═══
// 날짜변경선(180°)을 넘는 폴리곤을 분할

function fixAntiMeridianRing(ring: number[][]): number[][] {
  // Detect if ring crosses anti-meridian (large lon jump)
  let hasAntiMeridianCross = false
  for (let i = 0; i < ring.length - 1; i++) {
    if (Math.abs(ring[i][0] - ring[i + 1][0]) > 180) {
      hasAntiMeridianCross = true
      break
    }
  }

  if (!hasAntiMeridianCross) return ring

  // Normalize longitudes: shift to avoid the ±180 boundary
  // If ring has points near 180 and -180, shift negative longitudes by +360
  return ring.map(([lon, lat]) => {
    if (lon < -90) return [lon + 360, lat]
    return [lon, lat]
  })
}

// ═══ GeoJSON → GPU Mesh ═══

export function loadGeoJSON(data: GeoJSONFeatureCollection): {
  polygons: MeshData
  lines: LineMeshData
} {
  const polyVertices: number[] = []
  const polyIndices: number[] = []
  const polyFeatures: FeatureRange[] = []

  const lineVertices: number[] = []
  const lineIndices: number[] = []
  const lineFeatures: FeatureRange[] = []

  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity

  for (const feature of data.features) {
    const geom = feature.geometry

    if (geom.type === 'Polygon') {
      tessellatePolygon(geom.coordinates, feature.properties, polyVertices, polyIndices, polyFeatures)
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        tessellatePolygon(polygon, feature.properties, polyVertices, polyIndices, polyFeatures)
      }
    } else if (geom.type === 'LineString') {
      tessellateLineString(geom.coordinates, feature.properties, lineVertices, lineIndices, lineFeatures)
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        tessellateLineString(line, feature.properties, lineVertices, lineIndices, lineFeatures)
      }
    }
  }

  // Compute bounds (lon/lat degrees, stride 3: lon,lat,feat_id)
  for (let i = 0; i < polyVertices.length; i += 3) {
    const lon = polyVertices[i], lat = polyVertices[i + 1]
    if (lon < 500) {
      minLon = Math.min(minLon, lon)
      maxLon = Math.max(maxLon, lon)
    }
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }
  for (let i = 0; i < lineVertices.length; i += 3) {
    const lon = lineVertices[i], lat = lineVertices[i + 1]
    minLon = Math.min(minLon, lon)
    maxLon = Math.max(maxLon, lon)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
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

    let ring = fixAntiMeridianRing(rings[r])
    ring = subdivideRing(ring)

    for (const coord of ring) {
      flatCoords.push(coord[0], coord[1]) // earcut needs 2D
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
    const x0 = finalVertices[i0 * 2], y0 = finalVertices[i0 * 2 + 1]
    const x1 = finalVertices[i1 * 2], y1 = finalVertices[i1 * 2 + 1]
    const x2 = finalVertices[i2 * 2], y2 = finalVertices[i2 * 2 + 1]

    const d01 = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    const d12 = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))
    const d20 = Math.max(Math.abs(x0 - x2), Math.abs(y0 - y2))
    const maxEdge = Math.max(d01, d12, d20)

    if (maxEdge <= MAX_TRI_DEGREES || depth >= 5) {
      finalIndices.push(i0, i1, i2)
      return
    }

    const m01 = getOrAddVertex((x0 + x1) / 2, (y0 + y1) / 2)
    const m12 = getOrAddVertex((x1 + x2) / 2, (y1 + y2) / 2)
    const m20 = getOrAddVertex((x2 + x0) / 2, (y2 + y0) / 2)

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
  const STRIDE = 3
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
          subdivided.push([
            curr[0] + (next[0] - curr[0]) * t,
            curr[1] + (next[1] - curr[1]) * t,
          ])
        }
      }
    }
  }

  for (const coord of subdivided) {
    outVertices.push(coord[0], coord[1], featureId)
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
