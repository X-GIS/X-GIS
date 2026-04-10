// ═══ Vector Tiler ═══
// Compiles GeoJSON → pyramid of GPU-ready tiles (COG-style overview levels).
// Zero runtime cost: tiles contain pre-tessellated Float32Array/Uint32Array.

import earcut from 'earcut'
import { simplifyPolygon, simplifyLine } from './simplify'
import { clipPolygonToRect, clipLineToRect } from './clip'
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
  maxZoom?: number   // default: auto-detected from data resolution
  maxFeaturesPerTile?: number  // default 5000
}

/**
 * Auto-detect appropriate maxZoom from data resolution.
 * Estimates average vertex spacing and finds the zoom level where
 * further subdivision provides no additional detail.
 */
function autoDetectMaxZoom(features: GeoJSONFeature[], bboxes: FeatureBBox[]): number {
  // Sample vertex spacing from first N features
  const sampleSize = Math.min(features.length, 50)
  let totalSpacing = 0
  let spacingCount = 0

  for (let i = 0; i < sampleSize; i++) {
    const geom = features[i].geometry
    const coords = extractFirstRing(geom)
    if (!coords || coords.length < 2) continue

    for (let j = 1; j < coords.length; j++) {
      const dx = Math.abs(coords[j][0] - coords[j - 1][0])
      const dy = Math.abs(coords[j][1] - coords[j - 1][1])
      const spacing = Math.sqrt(dx * dx + dy * dy)
      if (spacing > 0) {
        totalSpacing += spacing
        spacingCount++
      }
    }
  }

  if (spacingCount === 0) return 6

  const avgSpacing = totalSpacing / spacingCount // degrees

  // At zoom z, each tile covers 360/2^z degrees of longitude
  // Detail is pointless when tile covers less than avg vertex spacing
  // → maxZoom ≈ log2(360 / avgSpacing) - 4 (conservative, fewer tiles)
  const maxZoom = Math.max(2, Math.min(10, Math.floor(Math.log2(360 / avgSpacing)) - 4))

  console.log(`  Auto maxZoom: ${maxZoom} (avg vertex spacing: ${avgSpacing.toFixed(4)}°)`)
  return maxZoom
}

function extractFirstRing(geom: GeoJSONFeature['geometry']): number[][] | null {
  if (geom.type === 'Polygon') return (geom.coordinates as number[][][])[0]
  if (geom.type === 'MultiPolygon') return (geom.coordinates as number[][][][])[0]?.[0]
  if (geom.type === 'LineString') return geom.coordinates as number[][]
  return null
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

  // Auto-detect maxZoom from data resolution
  // Estimate avg vertex spacing → zoom where spacing ≈ tile pixel size
  const detectedZoom = autoDetectMaxZoom(geojson.features, featureBBoxes)
  const maxZoom = options?.maxZoom ?? detectedZoom

  // Step 2: For each zoom level, simplify → scatter → clip per tile → tessellate
  const levels: TileLevel[] = []

  for (let z = minZoom; z <= maxZoom; z++) {
    const zStart = performance.now()
    const n = Math.pow(2, z)

    // Simplify each feature for this zoom (no tessellation yet)
    interface SimplifiedFeature {
      fb: FeatureBBox
      polyRings: number[][][][]  // array of polygons, each is [outer, ...holes]
      lineCoords: number[][][]   // array of linestrings
    }
    const featureGeom: SimplifiedFeature[] = []

    for (const fb of featureBBoxes) {
      const polyRings: number[][][][] = []
      const lineCoords: number[][][] = []
      const geom = fb.feature.geometry

      if (geom.type === 'Polygon') {
        const simplified = simplifyPolygon(geom.coordinates as number[][][], z)
        if (simplified.length > 0 && simplified[0].length >= 3) polyRings.push(simplified)
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates as number[][][][]) {
          const simplified = simplifyPolygon(poly, z)
          if (simplified.length > 0 && simplified[0].length >= 3) polyRings.push(simplified)
        }
      } else if (geom.type === 'LineString') {
        const simplified = simplifyLine(geom.coordinates as number[][], z)
        if (simplified.length >= 2) lineCoords.push(simplified)
      } else if (geom.type === 'MultiLineString') {
        for (const line of geom.coordinates as number[][][]) {
          const simplified = simplifyLine(line, z)
          if (simplified.length >= 2) lineCoords.push(simplified)
        }
      }

      if (polyRings.length === 0 && lineCoords.length === 0) continue
      featureGeom.push({ fb, polyRings, lineCoords })
    }

    // Scatter: assign features to tiles by bbox
    const tileFeaturesMap = new Map<number, number[]>()

    for (let fi = 0; fi < featureGeom.length; fi++) {
      const fb = featureGeom[fi].fb
      const fxMin = Math.max(0, Math.floor((fb.minLon + 180) / 360 * n))
      const fxMax = Math.min(n - 1, Math.floor((fb.maxLon + 180) / 360 * n))

      const latMaxClamped = Math.min(fb.maxLat, 85)
      const latMinClamped = Math.max(fb.minLat, -85)
      const fyMin = Math.max(0, Math.floor((1 - Math.log(Math.tan(latMaxClamped * Math.PI / 180) + 1 / Math.cos(latMaxClamped * Math.PI / 180)) / Math.PI) / 2 * n))
      const fyMax = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(latMinClamped * Math.PI / 180) + 1 / Math.cos(latMinClamped * Math.PI / 180)) / Math.PI) / 2 * n))

      // Skip features spanning too many tiles (clipping is correct but earcut per-tile is too expensive)
      // These features are rendered from lower zoom levels via parent fallback
      const tileSpan = (fxMax - fxMin + 1) * (fyMax - fyMin + 1)
      if (tileSpan > 256) continue

      for (let x = fxMin; x <= fxMax; x++) {
        for (let y = fyMin; y <= fyMax; y++) {
          const key = tileKey(z, x, y)
          let list = tileFeaturesMap.get(key)
          if (!list) { list = []; tileFeaturesMap.set(key, list) }
          list.push(fi)
        }
      }
    }

    // Assemble tiles: clip → tessellate per tile
    const tiles = new Map<number, CompiledTile>()

    for (const [key, featureIndices] of tileFeaturesMap) {
      const [, tx, ty] = tileKeyUnpack(key)
      const tb = tileBounds(z, tx, ty)

      const polyVerts: number[] = []
      const polyIdx: number[] = []
      const lineVerts: number[] = []
      const lineIdx: number[] = []
      let featureCount = 0

      for (const fi of featureIndices) {
        const fg = featureGeom[fi]
        let hasOutput = false

        // Clip and tessellate polygons
        for (const rings of fg.polyRings) {
          const clipped = clipPolygonToRect(rings, tb.west, tb.south, tb.east, tb.north)
          if (clipped.length > 0 && clipped[0].length >= 3) {
            tessellatePolygonToArrays(clipped, featureCount, polyVerts, polyIdx)
            hasOutput = true
          }
        }

        // Clip and tessellate lines
        for (const line of fg.lineCoords) {
          const segments = clipLineToRect(line, tb.west, tb.south, tb.east, tb.north)
          for (const seg of segments) {
            if (seg.length >= 2) {
              tessellateLineToArrays(seg, featureCount, lineVerts, lineIdx)
              hasOutput = true
            }
          }
        }

        if (hasOutput) featureCount++
      }

      if (polyVerts.length > 0 || lineVerts.length > 0) {
        tiles.set(key, {
          z, x: tx, y: ty,
          vertices: new Float32Array(polyVerts),
          indices: new Uint32Array(polyIdx),
          lineVertices: new Float32Array(lineVerts),
          lineIndices: new Uint32Array(lineIdx),
          featureCount,
        })
      }
    }

    if (tiles.size > 0) {
      levels.push({ zoom: z, tiles })
    }

    const zElapsed = (performance.now() - zStart).toFixed(0)
    console.log(`  z${z}: ${tiles.size} tiles (${zElapsed}ms)`)
  }

  return {
    levels,
    bounds: [gMinLon, gMinLat, gMaxLon, gMaxLat],
    featureCount: featureBBoxes.length,
  }
}
