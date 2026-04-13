// ═══ Vector Tiler ═══
// Compiles GeoJSON → pyramid of GPU-ready tiles (COG-style overview levels).
// Per-part decomposition: MultiPolygons are split into individual parts
// with tighter bounding boxes, dramatically reducing tile scatter for large features.

import earcut from 'earcut'
import { simplifyPolygon, simplifyLine } from './simplify'
import { clipPolygonToRect, clipLineToRect } from './clip'
import { precisionForZoom } from './encoding'
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
  fullCover?: boolean
  fullCoverFeatureId?: number
  /** Original clipped polygon rings for runtime sub-tiling */
  polygons?: { rings: number[][][]; featId: number }[]
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

export interface GeometryPart {
  type: 'polygon' | 'line'
  rings?: number[][][]
  coords?: number[][]
  featureIndex: number
  minLon: number; minLat: number; maxLon: number; maxLat: number
}

export function decomposeFeatures(features: GeoJSONFeature[]): GeometryPart[] {
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

// ═══ Full Cover Detection ═══

/** Signed area of a ring via shoelace formula (degrees²) */
function shoelaceArea(ring: number[][]): number {
  let area = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const j = (i + 1) % n
    area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1]
  }
  return area / 2
}

// ═══ Tessellation ═══

/** Project latitude to Mercator Y (unitless, for earcut topology only) */
function latToMercatorY(lat: number): number {
  const clamped = Math.max(-85.051, Math.min(85.051, lat))
  const rad = clamped * Math.PI / 180
  return Math.log(Math.tan(Math.PI / 4 + rad / 2))
}

/** Vertex dedup key: quantize to 1e6 (~0.1m), include feature ID */
function vertexKey(x: number, y: number, fid: number): string {
  return `${(x * 1e6) | 0},${(y * 1e6) | 0},${fid | 0}`
}

function tessellatePolygonToArrays(
  rings: number[][][],
  featureId: number,
  outVerts: number[],
  outIdx: number[],
  dedupMap?: Map<string, number>,
): void {
  // Original lon/lat coords for vertex output
  const flatCoords: number[] = []
  // Mercator-projected coords for earcut topology — triangle edges will be
  // straight in Mercator space, matching GPU rendering (no coastline overshoot)
  const mercCoords: number[] = []
  const holeIndices: number[] = []

  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIndices.push(flatCoords.length / 2)
    for (const coord of rings[r]) {
      flatCoords.push(coord[0], coord[1])
      mercCoords.push(coord[0], latToMercatorY(coord[1]))
    }
  }

  const earcutIdx = earcut(mercCoords, holeIndices.length > 0 ? holeIndices : undefined)

  if (dedupMap) {
    // Dedup: reuse existing vertices with same quantized position + feature ID
    const localToGlobal: number[] = []
    for (let i = 0; i < flatCoords.length; i += 2) {
      const x = flatCoords[i], y = flatCoords[i + 1]
      const key = vertexKey(x, y, featureId)
      let globalIdx = dedupMap.get(key)
      if (globalIdx === undefined) {
        globalIdx = outVerts.length / 3
        outVerts.push(x, y, featureId)
        dedupMap.set(key, globalIdx)
      }
      localToGlobal.push(globalIdx)
    }
    for (const idx of earcutIdx) {
      outIdx.push(localToGlobal[idx])
    }
  } else {
    const baseVertex = outVerts.length / 3
    for (let i = 0; i < flatCoords.length; i += 2) {
      outVerts.push(flatCoords[i], flatCoords[i + 1], featureId)
    }
    for (const idx of earcutIdx) {
      outIdx.push(baseVertex + idx)
    }
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
  /** Called after each zoom level is compiled — enables progressive rendering */
  onLevel?: (level: TileLevel, bounds: [number, number, number, number], propertyTable: PropertyTable) => void
  /** If true, yield to the event loop between zoom levels (browser only) */
  async?: boolean
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
  const maxZoom = Math.max(2, Math.min(7, Math.ceil(Math.log2(360 / (avgSpacing * 16)))))
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

  // Build property table early (needed for progressive onLevel callbacks)
  const propertyTable = buildPropertyTable(geojson.features)
  const bounds: [number, number, number, number] = [gMinLon, gMinLat, gMaxLon, gMaxLat]

  // Step 2: Per-zoom processing with adaptive subdivision
  const levels: TileLevel[] = []
  const needsSubdivision = new Set<number>()
  const scratch = { pv: [] as number[], pi: [] as number[], lv: [] as number[], li: [] as number[] }

  function processZoomLevel(z: number): void {
    processZoomLevelShared(z, minZoom, maxZoom, allParts, levels, needsSubdivision, scratch, bounds, propertyTable, options?.onLevel)
  }

  for (let z = minZoom; z <= maxZoom; z++) {
    processZoomLevel(z)
  }

  console.log(`  Properties: ${propertyTable.fieldNames.length} fields (${propertyTable.fieldNames.join(', ')})`)

  return {
    levels,
    bounds,
    featureCount: geojson.features.length,
    propertyTable,
  }
}

// ═══ Shared Zoom Level Processing ═══

function processZoomLevelShared(
  z: number,
  minZoom: number,
  maxZoom: number,
  allParts: GeometryPart[],
  levels: TileLevel[],
  needsSubdivision: Set<number>,
  scratch: { pv: number[]; pi: number[]; lv: number[]; li: number[] },
  bounds: [number, number, number, number],
  propertyTable: PropertyTable,
  onLevel?: (level: TileLevel, bounds: [number, number, number, number], propertyTable: PropertyTable) => void,
): void {
    const zStart = performance.now()

    // Simplification applied per-tile AFTER clipping (clip → simplify → tessellate)
    // This preserves tile boundary vertices while reducing interior detail
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
    // At z > minZoom, only create tiles whose parent was marked for subdivision
    const tileFeaturesMap = new Map<number, number[]>()

    for (let pi = 0; pi < preparedParts.length; pi++) {
      const sp = preparedParts[pi]
      const fxMin = lonToTileX(sp.minLon, z)
      const fxMax = lonToTileX(sp.maxLon, z)
      const fyMin = latToTileY(sp.maxLat, z) // lat reversed
      const fyMax = latToTileY(sp.minLat, z)

      for (let x = fxMin; x <= fxMax; x++) {
        for (let y = fyMin; y <= fyMax; y++) {
          // Adaptive: skip if parent tile didn't need subdivision
          if (z > minZoom) {
            const parentKey = tileKey(z, x, y) >>> 2 // tileKeyParent
            if (!needsSubdivision.has(parentKey)) continue
          }
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
      const dedupMap = new Map<string, number>()

      // Lock predicate: vertices on tile boundary edges must survive simplification
      // so adjacent tiles share identical edge geometry (no seams)
      const EPS = 1e-10
      const isOnBoundary = (c: number[]) =>
        Math.abs(c[0] - tb.west) < EPS || Math.abs(c[0] - tb.east) < EPS ||
        Math.abs(c[1] - tb.south) < EPS || Math.abs(c[1] - tb.north) < EPS

      // Track clipped rings for full-cover detection + ring storage
      let tileClippedRings: number[][][] = []
      let tilePolyFeatureIds = new Set<number>()
      const tilePolygons: { rings: number[][][]; featId: number }[] = []
      // Track pre/post simplification vertex counts for adaptive subdivision
      let preSimplifyVerts = 0
      let postSimplifyVerts = 0

      for (const pi of partIndices) {
        const sp = preparedParts[pi]
        const fid = sp.original.featureIndex // stable feature ID

        if (sp.rings) {
          const clipped = clipPolygonToRect(sp.rings, tb.west, tb.south, tb.east, tb.north, precisionForZoom(z))
          if (clipped.length > 0 && clipped[0].length >= 3) {
            tileClippedRings.push(...clipped)
            tilePolyFeatureIds.add(fid)
            for (const ring of clipped) preSimplifyVerts += ring.length
            // At maxZoom: use original data (for runtime sub-tiling)
            // Below maxZoom: simplify to reduce vertex count
            const dataRings = z < maxZoom ? simplifyPolygon(clipped, z, isOnBoundary) : clipped
            if (z < maxZoom) {
              for (const ring of dataRings) postSimplifyVerts += ring.length
            } else {
              postSimplifyVerts += preSimplifyVerts
            }
            if (dataRings.length > 0 && dataRings[0].length >= 3) {
              tessellatePolygonToArrays(dataRings, fid, scratch.pv, scratch.pi, dedupMap)
              featureIds.add(fid)
              tilePolygons.push({ rings: dataRings, featId: fid })
            }
          }
        }

        if (sp.coords) {
          const segments = clipLineToRect(sp.coords, tb.west, tb.south, tb.east, tb.north, precisionForZoom(z))
          for (const seg of segments) {
            if (seg.length >= 2) {
              preSimplifyVerts += seg.length
              const dataLine = z < maxZoom ? simplifyLine(seg, z, isOnBoundary) : seg
              if (z < maxZoom) {
                postSimplifyVerts += dataLine.length
              } else {
                postSimplifyVerts += seg.length
              }
              if (dataLine.length >= 2) {
                tessellateLineToArrays(dataLine, fid, scratch.lv, scratch.li)
                featureIds.add(fid)
              }
            }
          }
        }
      }

      // Full-cover detection: single feature, single ring, area matches tile
      let fullCover = false
      let fullCoverFeatId = -1
      if (tilePolyFeatureIds.size === 1 && tileClippedRings.length === 1) {
        const tileArea = (tb.east - tb.west) * (tb.north - tb.south)
        const polyArea = Math.abs(shoelaceArea(tileClippedRings[0]))
        if (Math.abs(polyArea - tileArea) / tileArea < 1e-6) {
          fullCover = true
          fullCoverFeatId = [...tilePolyFeatureIds][0]
          // Clear polygon data — client will generate a quad
          scratch.pv.length = 0
          scratch.pi.length = 0
        }
      }

      // Minimum size filter (full-cover tiles may have only line data or nothing)
      if (fullCover || ((scratch.pv.length >= 9 || scratch.lv.length >= 6) &&
          (scratch.pv.length > 0 || scratch.lv.length > 0))) {

        // Convert to tile-local coordinates for f32 precision
        for (let i = 0; i < scratch.pv.length; i += 3) {
          scratch.pv[i] -= tb.west
          scratch.pv[i + 1] -= tb.south
        }
        for (let i = 0; i < scratch.lv.length; i += 3) {
          scratch.lv[i] -= tb.west
          scratch.lv[i + 1] -= tb.south
        }

        tiles.set(key, {
          z, x: tx, y: ty,
          tileWest: tb.west,
          tileSouth: tb.south,
          vertices: new Float32Array(scratch.pv),
          indices: new Uint32Array(scratch.pi),
          lineVertices: new Float32Array(scratch.lv),
          lineIndices: new Uint32Array(scratch.li),
          featureCount: featureIds.size,
          fullCover,
          fullCoverFeatureId: fullCoverFeatId,
          polygons: tilePolygons.length > 0 ? tilePolygons : undefined,
        })

        // Adaptive subdivision:
        // - Full-cover tiles: always subdivide (original data has coastline/border detail at higher zoom)
        // - Other tiles: subdivide only if simplification removed vertices
        if (z < maxZoom && (fullCover || preSimplifyVerts > postSimplifyVerts)) {
          needsSubdivision.add(key)
        }
      }
    }

    if (tiles.size > 0) {
      const level = { zoom: z, tiles }
      levels.push(level)
      onLevel?.(level, bounds, propertyTable)
    }

    const fullCoverCount = [...tiles.values()].filter(t => t.fullCover).length
    const leafCount = tiles.size - [...tiles.keys()].filter(k => needsSubdivision.has(k)).length
    const zElapsed = (performance.now() - zStart).toFixed(0)
    console.log(`  z${z}: ${tiles.size} tiles${fullCoverCount > 0 ? ` (${fullCoverCount} full-cover)` : ''}${leafCount > 0 && z < maxZoom ? ` (${leafCount} leaf)` : ''} (${zElapsed}ms)`)
}

// ═══ On-Demand Single Tile Compilation ═══

/** Compile a single tile from raw geometry parts. Used for on-demand tiling
 *  where only visible tiles are compiled instead of the entire pyramid. */
export function compileSingleTile(
  parts: GeometryPart[],
  z: number, x: number, y: number,
  maxZoom: number,
): CompiledTile | null {
  const tb = tileBounds(z, x, y)
  const precision = precisionForZoom(z)
  const scratch = { pv: [] as number[], pi: [] as number[], lv: [] as number[], li: [] as number[] }
  const featureIds = new Set<number>()
  const dedupMap = new Map<string, number>()
  const EPS = 1e-10
  const isOnBoundary = (c: number[]) =>
    Math.abs(c[0] - tb.west) < EPS || Math.abs(c[0] - tb.east) < EPS ||
    Math.abs(c[1] - tb.south) < EPS || Math.abs(c[1] - tb.north) < EPS
  const tilePolygons: { rings: number[][][]; featId: number }[] = []

  for (const part of parts) {
    // Quick bbox reject
    if (part.maxLon < tb.west || part.minLon > tb.east ||
        part.maxLat < tb.south || part.minLat > tb.north) continue

    const fid = part.featureIndex

    if (part.type === 'polygon' && part.rings) {
      const clipped = clipPolygonToRect(part.rings, tb.west, tb.south, tb.east, tb.north, precision)
      if (clipped.length > 0 && clipped[0].length >= 3) {
        const dataRings = z < maxZoom ? simplifyPolygon(clipped, z, isOnBoundary) : clipped
        if (dataRings.length > 0 && dataRings[0].length >= 3) {
          tessellatePolygonToArrays(dataRings, fid, scratch.pv, scratch.pi, dedupMap)
          featureIds.add(fid)
          tilePolygons.push({ rings: dataRings, featId: fid })
        }
      }
    }

    if (part.type === 'line' && part.coords) {
      const segments = clipLineToRect(part.coords, tb.west, tb.south, tb.east, tb.north, precision)
      for (const seg of segments) {
        if (seg.length >= 2) {
          const dataLine = z < maxZoom ? simplifyLine(seg, z, isOnBoundary) : seg
          if (dataLine.length >= 2) {
            tessellateLineToArrays(dataLine, fid, scratch.lv, scratch.li)
            featureIds.add(fid)
          }
        }
      }
    }
  }

  if (scratch.pv.length < 9 && scratch.lv.length < 6) return null

  // Convert to tile-local coordinates
  for (let i = 0; i < scratch.pv.length; i += 3) {
    scratch.pv[i] -= tb.west; scratch.pv[i + 1] -= tb.south
  }
  for (let i = 0; i < scratch.lv.length; i += 3) {
    scratch.lv[i] -= tb.west; scratch.lv[i + 1] -= tb.south
  }

  return {
    z, x, y,
    tileWest: tb.west, tileSouth: tb.south,
    vertices: new Float32Array(scratch.pv),
    indices: new Uint32Array(scratch.pi),
    lineVertices: new Float32Array(scratch.lv),
    lineIndices: new Uint32Array(scratch.li),
    featureCount: featureIds.size,
    polygons: tilePolygons.length > 0 ? tilePolygons : undefined,
  }
}

/** Async version: yields to the event loop between zoom levels so the
 *  browser can render intermediate results (z0 appears immediately).
 *  Uses the same internal state as sync version (adaptive subdivision preserved). */
export async function compileGeoJSONToTilesAsync(
  geojson: GeoJSONFeatureCollection,
  options?: TilerOptions,
): Promise<CompiledTileSet> {
  const origOnLevel = options?.onLevel

  return new Promise<CompiledTileSet>((resolve) => {
    const minZoom = options?.minZoom ?? 0
    const maxZoom = options?.maxZoom ?? autoDetectMaxZoom(geojson.features)
    const allParts = decomposeFeatures(geojson.features)

    let gMinLon = Infinity, gMinLat = Infinity, gMaxLon = -Infinity, gMaxLat = -Infinity
    for (const p of allParts) {
      if (p.minLon < gMinLon) gMinLon = p.minLon
      if (p.maxLon > gMaxLon) gMaxLon = p.maxLon
      if (p.minLat < gMinLat) gMinLat = p.minLat
      if (p.maxLat > gMaxLat) gMaxLat = p.maxLat
    }
    const bounds: [number, number, number, number] = [gMinLon, gMinLat, gMaxLon, gMaxLat]
    const propertyTable = buildPropertyTable(geojson.features)
    const levels: TileLevel[] = []
    const needsSubdivision = new Set<number>()
    const scratch = { pv: [] as number[], pi: [] as number[], lv: [] as number[], li: [] as number[] }

    // Process one zoom level, then schedule the next via setTimeout
    function step(z: number) {
      processZoomLevelShared(z, minZoom, maxZoom, allParts, levels, needsSubdivision, scratch, bounds, propertyTable, origOnLevel)

      if (z < maxZoom) {
        setTimeout(() => step(z + 1), 0)
      } else {
        console.log(`  Properties: ${propertyTable.fieldNames.length} fields (${propertyTable.fieldNames.join(', ')})`)
        resolve({ levels, bounds, featureCount: geojson.features.length, propertyTable })
      }
    }

    console.log(`  Decomposed ${geojson.features.length} features → ${allParts.length} parts`)
    step(minZoom)
  })
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

