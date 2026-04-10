// ═══ Vector Tiler ═══
// Compiles GeoJSON → pyramid of GPU-ready tiles (COG-style overview levels).
// Zero runtime cost: tiles contain pre-tessellated Float32Array/Uint32Array.

import earcut from 'earcut'
import { simplifyPolygon, simplifyLine } from './simplify'
import type { GeoJSONFeatureCollection, GeoJSONFeature } from '../../runtime/src/loader/geojson'

// ═══ Types ═══

export interface CompiledTileSet {
  levels: TileLevel[]
  bounds: [number, number, number, number]
  featureCount: number
}

export interface TileLevel {
  zoom: number
  tiles: Map<number, CompiledTile> // tileKey(z,x,y) → tile
}

// ═══ Morton Code (Z-Order Curve) Tile Key ═══
//
// Interleaves x/y bits to create a spatially-coherent key.
// Adjacent tiles in 2D space have numerically adjacent keys → cache-friendly.
// Leading 1-bit sentinel encodes zoom level implicitly.
//
// Example: z=3, x=5(101), y=2(010)
//   Morton:   0,1, 0,0, 1,1  → 011001 (=25)
//   With sentinel: 1|01|10|01 (=89)
//
// Properties:
//   parent(key) = key >>> 2
//   children(key) = [key<<2 | 0..3]
//   Supports zoom 0-26 (fits in JS safe integer, 53 bits)

/** Interleave bits: spread x into even bit positions */
function spreadBits(v: number): number {
  v = (v | (v << 16)) & 0x0000ffff
  v = (v | (v <<  8)) & 0x00ff00ff
  v = (v | (v <<  4)) & 0x0f0f0f0f
  v = (v | (v <<  2)) & 0x33333333
  v = (v | (v <<  1)) & 0x55555555
  return v
}

/** Extract even bit positions (reverse of spreadBits) */
function compactBits(v: number): number {
  v &= 0x55555555
  v = (v | (v >>>  1)) & 0x33333333
  v = (v | (v >>>  2)) & 0x0f0f0f0f
  v = (v | (v >>>  4)) & 0x00ff00ff
  v = (v | (v >>>  8)) & 0x0000ffff
  return v
}

/** Pure Morton code: interleave x and y bits */
export function mortonEncode(x: number, y: number): number {
  return spreadBits(x) | (spreadBits(y) << 1)
}

/** Decode Morton code back to x, y */
export function mortonDecode(morton: number): [number, number] {
  return [compactBits(morton), compactBits(morton >>> 1)]
}

/**
 * Tile key: Morton code with leading 1-bit sentinel for zoom encoding.
 * Spatially adjacent tiles have numerically adjacent keys (Z-order curve).
 */
export function tileKey(z: number, x: number, y: number): number {
  // Sentinel bit at position 2*z, then Morton-interleaved x/y below
  return (1 << (2 * z)) | mortonEncode(x, y)
}

/** Extract z, x, y from a Morton tile key */
export function tileKeyUnpack(key: number): [number, number, number] {
  // Find zoom: position of the leading 1-bit
  let z = 0
  let tmp = key >>> 2
  while (tmp > 0) { z++; tmp >>>= 2 }

  // Strip sentinel, decode Morton
  const morton = key & ((1 << (2 * z)) - 1)
  const [x, y] = mortonDecode(morton)
  return [z, x, y]
}

/** Get parent tile key (one zoom level up) */
export function tileKeyParent(key: number): number {
  // Remove bottom 2 bits (one Morton level)
  return key >>> 2
}

/** Get four child tile keys (one zoom level down) */
export function tileKeyChildren(key: number): [number, number, number, number] {
  const base = key << 2
  return [base, base | 1, base | 2, base | 3]
}

export interface CompiledTile {
  z: number
  x: number
  y: number
  /** GPU-ready polygon vertices: [lon, lat, feat_id, ...] stride 3 */
  vertices: Float32Array
  /** GPU-ready polygon indices */
  indices: Uint32Array
  /** GPU-ready line vertices */
  lineVertices: Float32Array
  /** GPU-ready line indices */
  lineIndices: Uint32Array
  featureCount: number
}

interface FeatureBBox {
  feature: GeoJSONFeature
  featureIndex: number
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
}

// ═══ Tile Math (mirrors runtime/src/loader/tiles.ts) ═══

function tileBounds(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, z)
  const west = x / n * 360 - 180
  const east = (x + 1) / n * 360 - 180
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI
  return { west, south, east, north }
}

function bboxIntersects(
  a: { minLon: number; minLat: number; maxLon: number; maxLat: number },
  b: { west: number; south: number; east: number; north: number },
): boolean {
  return !(a.maxLon < b.west || a.minLon > b.east || a.maxLat < b.south || a.minLat > b.north)
}

// ═══ Feature BBox Computation ═══

function computeFeatureBBox(feature: GeoJSONFeature, index: number): FeatureBBox | null {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity

  function scanCoords(coords: unknown): void {
    if (!Array.isArray(coords)) return
    if (typeof coords[0] === 'number') {
      // [lon, lat]
      const lon = coords[0] as number, lat = coords[1] as number
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    } else {
      for (const c of coords) scanCoords(c)
    }
  }

  scanCoords(feature.geometry.coordinates)
  if (!isFinite(minLon)) return null

  return { feature, featureIndex: index, minLon, minLat, maxLon, maxLat }
}

// ═══ Tessellation (simplified from runtime/src/loader/geojson.ts) ═══

function tessellatePolygonToArrays(
  rings: number[][][],
  featureId: number,
  outVerts: number[],
  outIdx: number[],
): void {
  const baseVertex = outVerts.length / 3

  const flatCoords: number[] = []
  const holeIndices: number[] = []

  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIndices.push(flatCoords.length / 2)
    for (const coord of rings[r]) {
      flatCoords.push(coord[0], coord[1])
    }
  }

  const earcutIdx = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : undefined)

  // Emit vertices with feature ID (stride 3)
  for (let i = 0; i < flatCoords.length; i += 2) {
    outVerts.push(flatCoords[i], flatCoords[i + 1], featureId)
  }
  for (const idx of earcutIdx) {
    outIdx.push(baseVertex + idx)
  }
}

function tessellateLineToArrays(
  coords: number[][],
  featureId: number,
  outVerts: number[],
  outIdx: number[],
): void {
  const baseVertex = outVerts.length / 3

  for (const coord of coords) {
    outVerts.push(coord[0], coord[1], featureId)
  }
  for (let i = 0; i < coords.length - 1; i++) {
    outIdx.push(baseVertex + i, baseVertex + i + 1)
  }
}

// ═══ Main Tiler ═══

export interface TilerOptions {
  minZoom?: number   // default 0
  maxZoom?: number   // default 14 (auto-reduced if data resolution insufficient)
  maxFeaturesPerTile?: number  // default 5000
}

/**
 * Compile a GeoJSON FeatureCollection into a pyramid of GPU-ready tiles.
 * Uses COG-style overview levels with sparse storage.
 */
export function compileGeoJSONToTiles(
  geojson: GeoJSONFeatureCollection,
  options?: TilerOptions,
): CompiledTileSet {
  const minZoom = options?.minZoom ?? 0
  const maxZoom = options?.maxZoom ?? 14

  // Step 1: Compute feature bboxes
  const featureBBoxes: FeatureBBox[] = []
  for (let i = 0; i < geojson.features.length; i++) {
    const fb = computeFeatureBBox(geojson.features[i], i)
    if (fb) featureBBoxes.push(fb)
  }

  // Global bounds
  let gMinLon = Infinity, gMinLat = Infinity, gMaxLon = -Infinity, gMaxLat = -Infinity
  for (const fb of featureBBoxes) {
    gMinLon = Math.min(gMinLon, fb.minLon); gMaxLon = Math.max(gMaxLon, fb.maxLon)
    gMinLat = Math.min(gMinLat, fb.minLat); gMaxLat = Math.max(gMaxLat, fb.maxLat)
  }

  // Step 2: For each zoom level, generate tiles (sparse — skip empty tiles)
  const levels: TileLevel[] = []

  for (let z = minZoom; z <= maxZoom; z++) {
    const n = Math.pow(2, z)
    const tiles = new Map<number, CompiledTile>()

    // Determine tile range that covers the data bbox
    const xMin = Math.max(0, Math.floor((gMinLon + 180) / 360 * n))
    const xMax = Math.min(n - 1, Math.floor((gMaxLon + 180) / 360 * n))
    const yMin = Math.max(0, Math.floor((1 - Math.log(Math.tan(gMaxLat * Math.PI / 180) + 1 / Math.cos(gMaxLat * Math.PI / 180)) / Math.PI) / 2 * n))
    const yMax = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(Math.max(gMinLat, -85) * Math.PI / 180) + 1 / Math.cos(Math.max(gMinLat, -85) * Math.PI / 180)) / Math.PI) / 2 * n))

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        const tb = tileBounds(z, x, y)

        // Find features that intersect this tile
        const tileFeatures: FeatureBBox[] = []
        for (const fb of featureBBoxes) {
          if (bboxIntersects(fb, tb)) {
            tileFeatures.push(fb)
          }
        }

        if (tileFeatures.length === 0) continue // sparse: skip empty

        // Tessellate features for this tile
        const polyVerts: number[] = []
        const polyIdx: number[] = []
        const lineVerts: number[] = []
        const lineIdx: number[] = []
        let tileFeatureCount = 0

        for (const fb of tileFeatures) {
          const geom = fb.feature.geometry

          if (geom.type === 'Polygon') {
            const simplified = simplifyPolygon(geom.coordinates as number[][][], z)
            tessellatePolygonToArrays(simplified, tileFeatureCount, polyVerts, polyIdx)
            tileFeatureCount++
          } else if (geom.type === 'MultiPolygon') {
            for (const poly of geom.coordinates as number[][][][]) {
              const simplified = simplifyPolygon(poly, z)
              tessellatePolygonToArrays(simplified, tileFeatureCount, polyVerts, polyIdx)
            }
            tileFeatureCount++
          } else if (geom.type === 'LineString') {
            const simplified = simplifyLine(geom.coordinates as number[][], z)
            tessellateLineToArrays(simplified, tileFeatureCount, lineVerts, lineIdx)
            tileFeatureCount++
          } else if (geom.type === 'MultiLineString') {
            for (const line of geom.coordinates as number[][][]) {
              const simplified = simplifyLine(line, z)
              tessellateLineToArrays(simplified, tileFeatureCount, lineVerts, lineIdx)
            }
            tileFeatureCount++
          }
        }

        if (polyVerts.length === 0 && lineVerts.length === 0) continue

        tiles.set(tileKey(z, x, y), {
          z, x, y,
          vertices: new Float32Array(polyVerts),
          indices: new Uint32Array(polyIdx),
          lineVertices: new Float32Array(lineVerts),
          lineIndices: new Uint32Array(lineIdx),
          featureCount: tileFeatureCount,
        })
      }
    }

    if (tiles.size > 0) {
      levels.push({ zoom: z, tiles })
    }
  }

  return {
    levels,
    bounds: [gMinLon, gMinLat, gMaxLon, gMaxLat],
    featureCount: featureBBoxes.length,
  }
}
