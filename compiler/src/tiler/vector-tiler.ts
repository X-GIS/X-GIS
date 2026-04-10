// ═══ Vector Tiler ═══
// Compiles GeoJSON → pyramid of GPU-ready tiles (COG-style overview levels).
// Per-part decomposition: MultiPolygons are split into individual parts
// with tighter bounding boxes, dramatically reducing tile scatter for large features.

import earcut from 'earcut'
// simplify removed: original coordinates preserved for topology correctness
// import { simplifyPolygon, simplifyLine } from './simplify'
import { clipPolygonToRect, clipLineToRect } from './clip'
import type { GeoJSONFeatureCollection, GeoJSONFeature } from './geojson-types'

/** Tile coordinate extent (like MVT 4096, but higher for military precision) */
export const TILE_EXTENT = 8192

// ═══ Types ═══

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
  vertices: Float32Array   // tile-local coordinates: [dx, dy, feat_id] where dx=lon-tileWest
  indices: Uint32Array
  lineVertices: Float32Array
  lineIndices: Uint32Array
  featureCount: number
}

// ═══ Morton Code (Z-Order Curve) Tile Key ═══

function spreadBits(v: number): number {
  v = (v | (v << 16)) & 0x0000ffff
  v = (v | (v <<  8)) & 0x00ff00ff
  v = (v | (v <<  4)) & 0x0f0f0f0f
  v = (v | (v <<  2)) & 0x33333333
  v = (v | (v <<  1)) & 0x55555555
  return v
}

function compactBits(v: number): number {
  v &= 0x55555555
  v = (v | (v >>>  1)) & 0x33333333
  v = (v | (v >>>  2)) & 0x0f0f0f0f
  v = (v | (v >>>  4)) & 0x00ff00ff
  v = (v | (v >>>  8)) & 0x0000ffff
  return v
}

export function mortonEncode(x: number, y: number): number {
  return spreadBits(x) | (spreadBits(y) << 1)
}

export function mortonDecode(morton: number): [number, number] {
  return [compactBits(morton), compactBits(morton >>> 1)]
}

export function tileKey(z: number, x: number, y: number): number {
  return (1 << (2 * z)) | mortonEncode(x, y)
}

export function tileKeyUnpack(key: number): [number, number, number] {
  let z = 0
  let tmp = key >>> 2
  while (tmp > 0) { z++; tmp >>>= 2 }
  const morton = key & ((1 << (2 * z)) - 1)
  const [x, y] = mortonDecode(morton)
  return [z, x, y]
}

export function tileKeyParent(key: number): number {
  return key >>> 2
}

export function tileKeyChildren(key: number): [number, number, number, number] {
  const base = key << 2
  return [base, base | 1, base | 2, base | 3]
}

// ═══ Geometry Part: per-polygon/per-line with tight bbox ═══

interface GeometryPart {
  type: 'polygon' | 'line'
  rings?: number[][][]
  coords?: number[][]
  featureIndex: number
  minLon: number; minLat: number; maxLon: number; maxLat: number
}

function decomposeFeatures(features: GeoJSONFeature[]): GeometryPart[] {
  const parts: GeometryPart[] = []

  for (let fi = 0; fi < features.length; fi++) {
    const geom = features[fi].geometry
    if (!geom) continue

    if (geom.type === 'Polygon') {
      const rings = geom.coordinates as number[][][]
      parts.push(makePolygonPart(rings, fi))
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates as number[][][][]) {
        parts.push(makePolygonPart(poly, fi))
      }
    } else if (geom.type === 'LineString') {
      const coords = geom.coordinates as number[][]
      parts.push(makeLinePart(coords, fi))
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates as number[][][]) {
        parts.push(makeLinePart(line, fi))
      }
    }
  }

  return parts
}

function makePolygonPart(rings: number[][][], featureIndex: number): GeometryPart {
  const bbox = ringsBBox(rings[0]) // outer ring bbox
  return { type: 'polygon', rings, featureIndex, ...bbox }
}

function makeLinePart(coords: number[][], featureIndex: number): GeometryPart {
  const bbox = coordsBBox(coords)
  return { type: 'line', coords, featureIndex, ...bbox }
}

function ringsBBox(ring: number[][]): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat
  }
  return { minLon, minLat, maxLon, maxLat }
}

function coordsBBox(coords: number[][]): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  return ringsBBox(coords)
}

// ═══ Tile Math ═══

function tileBounds(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, z)
  return {
    west: x / n * 360 - 180,
    east: (x + 1) / n * 360 - 180,
    north: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI,
    south: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI,
  }
}

function lonToTileX(lon: number, z: number): number {
  const n = Math.pow(2, z)
  return Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n)))
}

function latToTileY(lat: number, z: number): number {
  const n = Math.pow(2, z)
  const clamped = Math.max(-85, Math.min(85, lat))
  return Math.max(0, Math.min(n - 1,
    Math.floor((1 - Math.log(Math.tan(clamped * Math.PI / 180) + 1 / Math.cos(clamped * Math.PI / 180)) / Math.PI) / 2 * n)
  ))
}

// ═══ Tessellation ═══

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

// ═══ Auto Zoom Detection ═══

export interface TilerOptions {
  minZoom?: number
  maxZoom?: number
}

function autoDetectMaxZoom(features: GeoJSONFeature[]): number {
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
      if (spacing > 0) { totalSpacing += spacing; spacingCount++ }
    }
  }

  if (spacingCount === 0) return 6

  const avgSpacing = totalSpacing / spacingCount
  // Tile at zoom z covers 360/2^z degrees. Cap conservatively to manage tile count.
  const maxZoom = Math.max(2, Math.min(8, Math.ceil(Math.log2(360 / (avgSpacing * 16)))))
  console.log(`  Auto maxZoom: ${maxZoom} (avg vertex spacing: ${avgSpacing.toFixed(4)}°)`)
  return maxZoom
}

function extractFirstRing(geom: GeoJSONFeature['geometry']): number[][] | null {
  if (geom.type === 'Polygon') return (geom.coordinates as number[][][])[0]
  if (geom.type === 'MultiPolygon') return (geom.coordinates as number[][][][])[0]?.[0]
  if (geom.type === 'LineString') return geom.coordinates as number[][]
  return null
}

// ═══ Main Tiler ═══

export function compileGeoJSONToTiles(
  geojson: GeoJSONFeatureCollection,
  options?: TilerOptions,
): CompiledTileSet {
  const minZoom = options?.minZoom ?? 0
  const maxZoom = options?.maxZoom ?? autoDetectMaxZoom(geojson.features)

  // Step 1: Decompose features into individual geometry parts with tight bboxes
  const allParts = decomposeFeatures(geojson.features)
  console.log(`  Decomposed ${geojson.features.length} features → ${allParts.length} parts`)

  // Global bounds
  let gMinLon = Infinity, gMinLat = Infinity, gMaxLon = -Infinity, gMaxLat = -Infinity
  for (const p of allParts) {
    if (p.minLon < gMinLon) gMinLon = p.minLon
    if (p.maxLon > gMaxLon) gMaxLon = p.maxLon
    if (p.minLat < gMinLat) gMinLat = p.minLat
    if (p.maxLat > gMaxLat) gMaxLat = p.maxLat
  }

  // Step 2: Per-zoom processing
  const levels: TileLevel[] = []

  // Reusable scratch arrays (reset per tile)
  const scratch = { pv: [] as number[], pi: [] as number[], lv: [] as number[], li: [] as number[] }

  for (let z = minZoom; z <= maxZoom; z++) {
    const zStart = performance.now()

    // Use original geometry (no simplification — preserves shared edges between adjacent features)
    interface PreparedPart {
      original: GeometryPart
      rings?: number[][][]
      coords?: number[][]
      minLon: number; minLat: number; maxLon: number; maxLat: number
    }

    const preparedParts: PreparedPart[] = []

    for (const part of allParts) {
      if (part.type === 'polygon' && part.rings) {
        if (part.rings.length === 0 || part.rings[0].length < 3) continue
        preparedParts.push({ original: part, rings: part.rings, minLon: part.minLon, minLat: part.minLat, maxLon: part.maxLon, maxLat: part.maxLat })
      } else if (part.type === 'line' && part.coords) {
        if (part.coords.length < 2) continue
        preparedParts.push({ original: part, coords: part.coords, minLon: part.minLon, minLat: part.minLat, maxLon: part.maxLon, maxLat: part.maxLat })
      }
    }

    // Scatter: assign parts to tiles using per-part bbox
    const tileFeaturesMap = new Map<number, number[]>()

    for (let pi = 0; pi < preparedParts.length; pi++) {
      const sp = preparedParts[pi]
      const fxMin = lonToTileX(sp.minLon, z)
      const fxMax = lonToTileX(sp.maxLon, z)
      const fyMin = latToTileY(sp.maxLat, z) // lat reversed
      const fyMax = latToTileY(sp.minLat, z)

      for (let x = fxMin; x <= fxMax; x++) {
        for (let y = fyMin; y <= fyMax; y++) {
          const key = tileKey(z, x, y)
          let list = tileFeaturesMap.get(key)
          if (!list) { list = []; tileFeaturesMap.set(key, list) }
          list.push(pi)
        }
      }
    }

    // Assemble tiles: clip → tessellate per tile
    const tiles = new Map<number, CompiledTile>()

    for (const [key, partIndices] of tileFeaturesMap) {
      const [, tx, ty] = tileKeyUnpack(key)
      const tb = tileBounds(z, tx, ty)

      scratch.pv.length = 0; scratch.pi.length = 0
      scratch.lv.length = 0; scratch.li.length = 0
      const featureIds = new Set<number>()

      for (const pi of partIndices) {
        const sp = preparedParts[pi]
        const fid = sp.original.featureIndex // stable feature ID

        if (sp.rings) {
          const clipped = clipPolygonToRect(sp.rings, tb.west, tb.south, tb.east, tb.north)
          if (clipped.length > 0 && clipped[0].length >= 3) {
            tessellatePolygonToArrays(clipped, fid, scratch.pv, scratch.pi)
            featureIds.add(fid)
          }
        }

        if (sp.coords) {
          const segments = clipLineToRect(sp.coords, tb.west, tb.south, tb.east, tb.north)
          for (const seg of segments) {
            if (seg.length >= 2) {
              tessellateLineToArrays(seg, fid, scratch.lv, scratch.li)
              featureIds.add(fid)
            }
          }
        }
      }

      // Minimum size filter: skip tiles with < 1 triangle (9 floats = 3 vertices × stride 3)
      if ((scratch.pv.length >= 9 || scratch.lv.length >= 6) &&
          (scratch.pv.length > 0 || scratch.lv.length > 0)) {

        // Store absolute lon/lat coordinates (GPU uses RTC for precision)
        tiles.set(key, {
          z, x: tx, y: ty,
          tileWest: tb.west,
          tileSouth: tb.south,
          vertices: new Float32Array(scratch.pv),
          indices: new Uint32Array(scratch.pi),
          lineVertices: new Float32Array(scratch.lv),
          lineIndices: new Uint32Array(scratch.li),
          featureCount: featureIds.size,
        })
      }
    }

    if (tiles.size > 0) {
      levels.push({ zoom: z, tiles })
    }

    const zElapsed = (performance.now() - zStart).toFixed(0)
    console.log(`  z${z}: ${tiles.size} tiles (${zElapsed}ms)`)
  }

  // Note: Overview dedup disabled — removing tiles creates gaps that require
  // parent fallback, which conflicts with alpha blending. All tiles are kept.
  // File size is managed by zoom-adaptive precision and simplification instead.

  // Build property table from original GeoJSON features
  const propertyTable = buildPropertyTable(geojson.features)
  console.log(`  Properties: ${propertyTable.fieldNames.length} fields (${propertyTable.fieldNames.join(', ')})`)

  return {
    levels,
    bounds: [gMinLon, gMinLat, gMaxLon, gMaxLat],
    featureCount: geojson.features.length,
    propertyTable,
  }
}

/**
 * Build a property table from GeoJSON features.
 * Scans all features to determine field names, types, and values.
 */
function buildPropertyTable(features: GeoJSONFeature[]): PropertyTable {
  // Collect union of all property keys
  const fieldSet = new Map<string, PropertyFieldType>()

  for (const feature of features) {
    if (!feature.properties) continue
    for (const [key, val] of Object.entries(feature.properties)) {
      if (val === null || val === undefined) continue
      const existing = fieldSet.get(key)
      const valType = typeof val === 'number' ? 'f64' : typeof val === 'boolean' ? 'bool' : 'string'
      if (!existing) {
        fieldSet.set(key, valType)
      } else if (existing !== valType) {
        fieldSet.set(key, 'string') // mixed types → string
      }
    }
  }

  const fieldNames = [...fieldSet.keys()]
  const fieldTypes = fieldNames.map(k => fieldSet.get(k)!)

  // Build values array
  const values: (number | string | boolean | null)[][] = []
  for (const feature of features) {
    const row: (number | string | boolean | null)[] = []
    for (const name of fieldNames) {
      const val = feature.properties?.[name]
      if (val === undefined || val === null) {
        row.push(null)
      } else {
        row.push(val as number | string | boolean)
      }
    }
    values.push(row)
  }

  return { fieldNames, fieldTypes, values }
}

