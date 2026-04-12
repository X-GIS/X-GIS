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
// 날짜변경선(180°)을 넘는 폴리곤을 Sutherland-Hodgman 클리핑으로 분할
// 절대 좌표 공간에서 earcut하면 내부 삼각형 변이 지구를 횡단 → 반드시 분할 필요

/** Detect if a ring crosses the anti-meridian (±180°) */
function detectsAntiMeridianCross(ring: number[][]): boolean {
  for (let i = 0; i < ring.length - 1; i++) {
    if (Math.abs(ring[i][0] - ring[i + 1][0]) > 180) return true
  }
  // World-wrapping polygons (Antarctica spans -180° to +180°)
  let minLon = Infinity, maxLon = -Infinity
  for (const [lon] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  return maxLon - minLon > 350
}

/** Clip a ring at a longitude cut line using Sutherland-Hodgman algorithm */
function clipRingAtLon(ring: number[][], cutLon: number, keepLess: boolean): number[][] {
  const result: number[][] = []
  const n = ring.length
  // Treat as closed ring: last vertex connects to first
  const len = ring[n - 1][0] === ring[0][0] && ring[n - 1][1] === ring[0][1] ? n - 1 : n

  for (let i = 0; i < len; i++) {
    const curr = ring[i]
    const next = ring[(i + 1) % len]
    const currIn = keepLess ? curr[0] <= cutLon : curr[0] >= cutLon
    const nextIn = keepLess ? next[0] <= cutLon : next[0] >= cutLon

    if (currIn) {
      result.push(curr)
      if (!nextIn) {
        // Exiting: add intersection point at cutLon
        const t = (cutLon - curr[0]) / (next[0] - curr[0])
        result.push([cutLon, curr[1] + t * (next[1] - curr[1])])
      }
    } else if (nextIn) {
      // Entering: add intersection point at cutLon
      const t = (cutLon - curr[0]) / (next[0] - curr[0])
      result.push([cutLon, curr[1] + t * (next[1] - curr[1])])
    }
  }

  // Close the ring
  if (result.length > 0) {
    const first = result[0], last = result[result.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) {
      result.push([first[0], first[1]])
    }
  }
  return result
}

/**
 * Split polygon rings at the anti-meridian (180°).
 * Returns an array of polygon ring-sets, each tessellated independently.
 * Most polygons return [[original rings]]. Anti-meridian polygons return
 * [[west rings], [east rings]] where each is a valid polygon.
 */
function splitRingsAtAntiMeridian(rings: number[][][]): number[][][][] {
  const outerRing = rings[0]
  if (!detectsAntiMeridianCross(outerRing)) return [rings]

  // Step 1: Shift negative longitudes to create continuous coordinate space
  const shift = (ring: number[][]): number[][] =>
    ring.map(([lon, lat]) => lon < -90 ? [lon + 360, lat] : [lon, lat])

  const shiftedOuter = shift(outerRing)

  // Step 2: Check if shifted ring actually crosses 180°
  let hasEast = false
  for (const [lon] of shiftedOuter) {
    if (lon > 180) { hasEast = true; break }
  }
  if (!hasEast) {
    // After shift, everything is ≤180° — no split needed
    return [[shiftedOuter, ...rings.slice(1).map(shift)]]
  }

  // Step 3: Clip outer ring at lon=180° into west and east parts
  const westOuter = clipRingAtLon(shiftedOuter, 180, true)
  const eastOuter = clipRingAtLon(shiftedOuter, 180, false)

  // Shift east part back by -360° to standard [-180, 0] range
  const eastOuterShifted = eastOuter.map(([lon, lat]) => [lon - 360, lat])

  const results: number[][][][] = []

  // Step 4: Handle holes — assign each hole to west or east based on centroid
  const westHoles: number[][][] = []
  const eastHoles: number[][][] = []
  for (let r = 1; r < rings.length; r++) {
    const hole = shift(rings[r])
    let sumLon = 0
    for (const [lon] of hole) sumLon += lon
    const avgLon = sumLon / hole.length
    if (avgLon <= 180) {
      westHoles.push(hole)
    } else {
      eastHoles.push(hole.map(([lon, lat]) => [lon - 360, lat]))
    }
  }

  if (westOuter.length >= 4) results.push([westOuter, ...westHoles])
  if (eastOuterShifted.length >= 4) results.push([eastOuterShifted, ...eastHoles])

  return results
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
    if (!geom) continue  // skip features with null geometry

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
  // Split at anti-meridian: each part is tessellated independently
  // This prevents earcut from creating internal edges that span the globe
  const parts = splitRingsAtAntiMeridian(rings)
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
      // Clamp latitude to Mercator limit (±85.051°) — Antarctica at -90° → -85°
      flatCoords.push(coord[0], Math.max(-85.051, Math.min(85.051, coord[1])))
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
