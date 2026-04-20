// ═══ Vector Tiler ═══
// Compiles GeoJSON → pyramid of GPU-ready tiles (COG-style overview levels).
// Per-part decomposition: MultiPolygons are split into individual parts
// with tighter bounding boxes, dramatically reducing tile scatter for large features.

import earcut from 'earcut'
import { simplifyPolygon, simplifyLine, mercatorToleranceForZoom } from './simplify'
import { clipPolygonToRect, clipLineToRect } from './clip'
import { precisionForZoom } from './encoding'
import type { GeoJSONFeatureCollection, GeoJSONFeature } from './geojson-types'

/** Tile coordinate extent (like MVT 4096, but higher for military precision) */
export const TILE_EXTENT = 8192

// ═══ DSFUN (Double-Single FUNction) helpers ═══
// Tile vertices are stored as (high, low) f32 pairs of tile-local Mercator
// meters. high + low reconstructs an f64-equivalent value; the shader
// subtracts (pos_h - cam_h) + (pos_l - cam_l) to preserve precision under
// large-magnitude subtraction. See docs/dsfun-refactor-plan.md.

const DSFUN_EARTH_R = 6378137
const DSFUN_DEG2RAD = Math.PI / 180
const DSFUN_LAT_LIMIT = 85.051129

/** Convert (lon_deg, lat_deg) to Mercator meters in f64. */
export function lonLatToMercF64(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-DSFUN_LAT_LIMIT, Math.min(DSFUN_LAT_LIMIT, lat))
  const mx = lon * DSFUN_DEG2RAD * DSFUN_EARTH_R
  const my = Math.log(Math.tan(Math.PI / 4 + clamped * DSFUN_DEG2RAD / 2)) * DSFUN_EARTH_R
  return [mx, my]
}

/** Split an f64 TS number into (high, low) f32 pair where high + low ≈ value. */
export function splitF64(x: number): [number, number] {
  const h = Math.fround(x)
  const l = Math.fround(x - h)
  return [h, l]
}

/**
 * Pack a stride-3 scratch array of absolute (lon, lat, feat_id) vertices into a
 * stride-5 DSFUN Float32Array of tile-local Mercator meters:
 *   [mx_h, my_h, mx_l, my_l, feat_id]
 * The tile origin (tileMx, tileMy) is subtracted in f64 before splitting, so
 * the resulting high/low pair can reconstruct f64-equivalent precision on the
 * GPU via (pos_h - cam_h) + (pos_l - cam_l).
 */
export function packDSFUNPolygonVertices(
  scratchPv: number[] | Float64Array,
  tileMx: number,
  tileMy: number,
): Float32Array {
  const count = scratchPv.length / 3
  const out = new Float32Array(count * 5)
  for (let i = 0; i < count; i++) {
    const lon = scratchPv[i * 3]
    const lat = scratchPv[i * 3 + 1]
    const fid = scratchPv[i * 3 + 2]
    const clamped = Math.max(-DSFUN_LAT_LIMIT, Math.min(DSFUN_LAT_LIMIT, lat))
    const mx = lon * DSFUN_DEG2RAD * DSFUN_EARTH_R
    const my = Math.log(Math.tan(Math.PI / 4 + clamped * DSFUN_DEG2RAD / 2)) * DSFUN_EARTH_R
    const localMx = mx - tileMx
    const localMy = my - tileMy
    const mxH = Math.fround(localMx)
    const mxL = Math.fround(localMx - mxH)
    const myH = Math.fround(localMy)
    const myL = Math.fround(localMy - myH)
    const base = i * 5
    out[base] = mxH
    out[base + 1] = myH
    out[base + 2] = mxL
    out[base + 3] = myL
    out[base + 4] = fid
  }
  return out
}

/**
 * Pack a stride-4 scratch array of absolute (lon, lat, feat_id, arc_start)
 * line vertices into a stride-6 DSFUN Float32Array:
 *   [mx_h, my_h, mx_l, my_l, feat_id, arc_start]
 */
export function packDSFUNLineVertices(
  scratchLv: number[] | Float64Array,
  tileMx: number,
  tileMy: number,
): Float32Array {
  // Input stride 8: [mx, my, featId, arc, tin_x, tin_y, tout_x, tout_y]
  // Coordinates are ALREADY in absolute Mercator meters (from augmentLineWithArc).
  // Output stride 10: [mx_h, my_h, mx_l, my_l, feat_id, arc, tin_x, tin_y, tout_x, tout_y]
  const IN_STRIDE = 8
  const OUT_STRIDE = 10
  const count = scratchLv.length / IN_STRIDE
  const out = new Float32Array(count * OUT_STRIDE)
  for (let i = 0; i < count; i++) {
    const si = i * IN_STRIDE
    const mx = scratchLv[si]
    const my = scratchLv[si + 1]
    const fid = scratchLv[si + 2]
    const arc = scratchLv[si + 3]
    const tinX = scratchLv[si + 4]
    const tinY = scratchLv[si + 5]
    const toutX = scratchLv[si + 6]
    const toutY = scratchLv[si + 7]
    const localMx = mx - tileMx
    const localMy = my - tileMy
    const mxH = Math.fround(localMx)
    const mxL = Math.fround(localMx - mxH)
    const myH = Math.fround(localMy)
    const myL = Math.fround(localMy - myH)
    const di = i * OUT_STRIDE
    out[di] = mxH
    out[di + 1] = myH
    out[di + 2] = mxL
    out[di + 3] = myL
    out[di + 4] = fid
    out[di + 5] = arc
    out[di + 6] = tinX
    out[di + 7] = tinY
    out[di + 8] = toutX
    out[di + 9] = toutY
  }
  return out
}

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

// ═══ Morton Code (Z-Order Curve) Tile Key ═══
//
// Tile keys pack (z, x, y) into one f64-safe integer:
//   key = 4^z + mortonEncode(x, y)
//
// For z ≤ 15 the key fits in 32 bits and the bit-twiddling hacks
// (spreadBits/compactBits) produce identical values to the loop form.
// For z > 15 (DSFUN unlocked camera zooms 16–22) we need f64 arithmetic
// because `1 << 32` overflows JavaScript's 32-bit shift semantics and
// spreadBits truncates inputs to 16 bits.
//
// Max supported zoom = 22. At z=22, x and y reach 2^22, morton reaches
// 2^44, and the key plus z-prefix stays well below 2^53 (JS integer limit).

const MAX_TILE_ZOOM = 22

/** Spread the 22 low bits of `v` into even positions of a 44-bit result. */
function spreadBits22(v: number): number {
  let result = 0
  for (let i = 0; i < MAX_TILE_ZOOM; i++) {
    if ((v & (1 << i)) !== 0) result += Math.pow(2, 2 * i)
  }
  return result
}

/** Collect bits at positions `startBit`, `startBit+2`, `startBit+4`, … back into a packed integer. */
function collectBits22(morton: number, startBit: number): number {
  let result = 0
  for (let i = 0; i < MAX_TILE_ZOOM; i++) {
    const pow = Math.pow(2, 2 * i + startBit)
    if (Math.floor(morton / pow) % 2 === 1) result |= (1 << i)
  }
  return result
}

export function mortonEncode(x: number, y: number): number {
  return spreadBits22(x) + 2 * spreadBits22(y)
}

export function mortonDecode(morton: number): [number, number] {
  return [collectBits22(morton, 0), collectBits22(morton, 1)]
}

export function tileKey(z: number, x: number, y: number): number {
  return Math.pow(4, z) + mortonEncode(x, y)
}

export function tileKeyUnpack(key: number): [number, number, number] {
  // Find the largest z such that 4^z ≤ key.
  let z = 0
  let acc = 1 // 4^0
  while (acc * 4 <= key) {
    acc *= 4
    z++
  }
  const morton = key - acc
  const [x, y] = mortonDecode(morton)
  return [z, x, y]
}

export function tileKeyParent(key: number): number {
  const [z, x, y] = tileKeyUnpack(key)
  // x >> 1 is always safe (22-bit → 21-bit).
  return tileKey(z - 1, x >>> 1, y >>> 1)
}

export function tileKeyChildren(key: number): [number, number, number, number] {
  const [z, x, y] = tileKeyUnpack(key)
  const cz = z + 1
  const cx = x * 2
  const cy = y * 2
  return [
    tileKey(cz, cx,     cy),
    tileKey(cz, cx + 1, cy),
    tileKey(cz, cx,     cy + 1),
    tileKey(cz, cx + 1, cy + 1),
  ]
}

// ═══ Geometry Part: per-polygon/per-line with tight bbox ═══

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

const defaultIdResolver: FeatureIdResolver = (_f, i) => i

export function decomposeFeatures(
  features: GeoJSONFeature[],
  idResolver: FeatureIdResolver = defaultIdResolver,
): GeometryPart[] {
  const parts: GeometryPart[] = []

  for (let fi = 0; fi < features.length; fi++) {
    const feature = features[fi]
    const geom = feature.geometry
    if (!geom) continue
    const id = idResolver(feature, fi)

    if (geom.type === 'Polygon') {
      const rings = geom.coordinates as number[][][]
      parts.push(makePolygonPart(rings, id))
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates as number[][][][]) {
        parts.push(makePolygonPart(poly, id))
      }
    } else if (geom.type === 'LineString') {
      const coords = geom.coordinates as number[][]
      parts.push(makeLinePart(coords, id))
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates as number[][][]) {
        parts.push(makeLinePart(line, id))
      }
    } else if (geom.type === 'Point') {
      const coord = geom.coordinates as number[]
      parts.push({ type: 'point', point: coord, featureIndex: id, minLon: coord[0], minLat: coord[1], maxLon: coord[0], maxLat: coord[1] })
    } else if (geom.type === 'MultiPoint') {
      for (const coord of geom.coordinates as number[][]) {
        parts.push({ type: 'point', point: coord, featureIndex: id, minLon: coord[0], minLat: coord[1], maxLon: coord[0], maxLat: coord[1] })
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

/**
 * Project an open polyline OR a closed polygon ring to Mercator meters
 * with per-vertex arc-length + tangents — the lossless input shape that
 * `clipLineToRect` and `tessellateLineToArrays` expect. Each output
 * vertex is a 7-tuple `[mxAbs, myAbs, arcStart, tin_x, tin_y, tout_x,
 * tout_y]`; arcStart and tangents are computed once on the ORIGINAL
 * unclipped chain so they survive tile splitting (clipLineToRect
 * interpolates arc at boundary crossings; tangents at original vertices
 * are preserved as-is, mid-segment clip points get zero tangents and
 * the runtime falls back to its boundary-detection heuristic).
 *
 * `closed=true` treats the input as a polygon ring: the last vertex
 * connects back to the first, the closing segment contributes to the
 * arc total, and the wrap vertex is appended so the renderer can draw
 * the close-segment without inventing a cap. GeoJSON's "first vertex
 * duplicated at end" convention is detected and stripped — passing a
 * `[A, B, C, D, A]` ring works the same as passing `[A, B, C, D]`.
 *
 * `closed=false` matches the legacy `augmentLineWithArc` behaviour
 * (open polyline with cap-style endpoints).
 *
 * Why this exists as one helper: polygon outlines and line features
 * share every downstream stage (clip, tessellate, GPU stride-10
 * pack, SDF segment build). The only meaningful difference is the
 * wrap-around at the close. Keeping the projection / arc / tangent
 * math in one place means a future precision tweak (e.g., switching
 * f64 Mercator to a higher-precision projection) lives in one spot
 * and doesn't drift between the two paths.
 */
function augmentChainWithArc(coords: number[][], closed: boolean): number[][] {
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  const LAT_LIMIT = 85.051129
  const clampLat = (v: number) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))

  // For closed rings, strip GeoJSON's trailing duplicate-of-first
  // vertex so we don't emit a zero-length wrap segment. The wrap is
  // handled explicitly below.
  //
  // Demotion: binary .xgvt tiles store per-tile-clipped polygon rings
  // that may be open chains (when clipping cut across the ring at a
  // tile boundary). When `closed=true` is passed for input that
  // doesn't actually close, demote to open chain rather than dropping
  // it — this keeps the shared compiler helper usable from both the
  // GeoJSON tiler (always closed source rings) and runtime decoders
  // that can't always tell ahead of time.
  let n = coords.length
  let actuallyClosed = closed
  if (closed && n >= 4) {
    const f = coords[0], l = coords[n - 1]
    if (Math.abs(f[0] - l[0]) < 1e-12 && Math.abs(f[1] - l[1]) < 1e-12) n -= 1
  } else if (closed && n >= 2) {
    // Open chain mistakenly tagged as closed — treat as line.
    actuallyClosed = false
  }
  if (actuallyClosed && n < 3) return []
  if (!actuallyClosed && n < 2) return []

  // Output length: open chain emits N vertices; closed ring emits N+1
  // (the appended wrap vertex carries arc=perimeter so the closing
  // segment t_along stays monotonic).
  const outN = actuallyClosed ? n + 1 : n

  // Pass 1: project + accumulate arc. For closed rings, also walk the
  // closing segment so arcArr[n] is the full perimeter.
  const mxArr = new Float64Array(n)
  const myArr = new Float64Array(n)
  const arcArr = new Float64Array(outN)
  let arc = 0
  for (let i = 0; i < n; i++) {
    const c = coords[i]
    mxArr[i] = c[0] * DEG2RAD * R
    myArr[i] = Math.log(Math.tan(Math.PI / 4 + clampLat(c[1]) * DEG2RAD / 2)) * R
    if (i > 0) {
      const dx = mxArr[i] - mxArr[i - 1], dy = myArr[i] - myArr[i - 1]
      arc += Math.sqrt(dx * dx + dy * dy)
    }
    arcArr[i] = arc
  }
  if (actuallyClosed) {
    const dx = mxArr[0] - mxArr[n - 1], dy = myArr[0] - myArr[n - 1]
    arc += Math.sqrt(dx * dx + dy * dy)
    arcArr[n] = arc
  }

  // Pass 2: emit per-vertex tangents.
  //
  //   tangent_in[i]  = unit direction arriving at vertex i (prev → i)
  //   tangent_out[i] = unit direction leaving  vertex i (i → next)
  //
  // Open chain: endpoints have a zero tangent on the missing side so
  // the renderer draws a cap there.
  // Closed ring: tangents wrap (prev of 0 = n-1, next of n-1 = 0) so
  // every join sees real neighbours and no spurious cap is drawn at
  // the start/end vertex of the wrap.
  const out: number[][] = new Array(outN)
  const tan = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay
    const len = Math.sqrt(dx * dx + dy * dy)
    return len > 1e-9 ? [dx / len, dy / len] : [0, 0]
  }
  for (let i = 0; i < n; i++) {
    let tin: number[] = [0, 0]
    let tout: number[] = [0, 0]
    if (actuallyClosed) {
      const prev = (i - 1 + n) % n
      const next = (i + 1) % n
      tin = tan(mxArr[prev], myArr[prev], mxArr[i], myArr[i])
      tout = tan(mxArr[i], myArr[i], mxArr[next], myArr[next])
    } else {
      if (i > 0) tin = tan(mxArr[i - 1], myArr[i - 1], mxArr[i], myArr[i])
      if (i < n - 1) tout = tan(mxArr[i], myArr[i], mxArr[i + 1], myArr[i + 1])
    }
    out[i] = [mxArr[i], myArr[i], arcArr[i], tin[0], tin[1], tout[0], tout[1]]
  }
  // Wrap vertex for closed rings: same coords as vertex 0 but
  // arc=perimeter. Tangent_in matches the closing segment (n-1→0),
  // tangent_out matches the first segment (0→1) so the join looks
  // identical to a regular interior join.
  if (actuallyClosed) {
    const tin = tan(mxArr[n - 1], myArr[n - 1], mxArr[0], myArr[0])
    const tout = n > 1
      ? tan(mxArr[0], myArr[0], mxArr[1], myArr[1])
      : [0, 0]
    out[n] = [mxArr[0], myArr[0], arcArr[n], tin[0], tin[1], tout[0], tout[1]]
  }
  return out
}

/** Polygon ring → arc-augmented chain (closed). Thin shim around
 *  `augmentChainWithArc` for call-site readability. Exported for
 *  runtime sub-tilers that need to derive cross-tile-continuous
 *  outline geometry from `polygons` preserved on a TileData. */
export function augmentRingWithArc(ring: number[][]): number[][] {
  return augmentChainWithArc(ring, true)
}

/** Remove consecutive duplicate (lon, lat) vertices from a ring.
 *  clipPolygonToRect occasionally emits rings that start with a
 *  duplicate of the first vertex; such duplicates become zero-length
 *  degenerate segments downstream and poison buildLineSegments'
 *  adjacency lookup. Epsilon of 1e-12 deg (~0.1 nm) matches the
 *  tolerance used by augmentChainWithArc for the closing-duplicate
 *  detection. */
function dedupAdjacentVertices(ring: number[][]): number[][] {
  if (ring.length < 2) return ring
  const out: number[][] = [ring[0]]
  for (let i = 1; i < ring.length; i++) {
    const prev = out[out.length - 1]
    const cur = ring[i]
    if (Math.abs(prev[0] - cur[0]) < 1e-12 && Math.abs(prev[1] - cur[1]) < 1e-12) continue
    out.push(cur)
  }
  return out
}

/** Open polyline → arc-augmented chain. Thin shim around
 *  `augmentChainWithArc` for call-site readability. */
function augmentLineWithArc(coords: number[][]): number[][] {
  return augmentChainWithArc(coords, false)
}

/** Push a single chain (open or closed-and-augmented) into stride-8
 *  scratch arrays + emit consecutive-pair line indices. Exported for
 *  runtime sub-tilers that need to assemble outline scratch from
 *  per-tile clipped chains. */
export function tessellateLineToArrays(
  coords: number[][],
  featureId: number,
  outVerts: number[],
  outIdx: number[],
): void {
  // Stride 8: [lon, lat, featId, arcStart, tangent_in_x, tangent_in_y, tangent_out_x, tangent_out_y]
  const baseVertex = outVerts.length / 8
  for (const coord of coords) {
    outVerts.push(
      coord[0], coord[1], featureId, coord[2] ?? 0,
      coord[3] ?? 0, coord[4] ?? 0, coord[5] ?? 0, coord[6] ?? 0,
    )
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
  /** Optional resolver for stable feature ids. Defaults to array index. */
  idResolver?: FeatureIdResolver
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
  const allParts = decomposeFeatures(geojson.features, options?.idResolver)
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
  const scratch = { pv: [] as number[], pi: [] as number[], lv: [] as number[], li: [] as number[], ptv: [] as number[], olv: [] as number[], oli: [] as number[] }

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
  scratch: { pv: number[]; pi: number[]; lv: number[]; li: number[]; ptv: number[]; olv: number[]; oli: number[] },
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
      } else if (part.type === 'point' && part.point) {
        // Points carry their single coord as both min and max so the scatter
        // bbox math below places them in exactly one tile per world copy.
        preparedParts.push({ original: part, minLon: part.minLon, minLat: part.minLat, maxLon: part.maxLon, maxLat: part.maxLat })
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
            const parentKey = tileKey(z - 1, x >>> 1, y >>> 1)
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
      // Mercator tile bounds for line clipping (lines must be clipped in
      // Mercator space to match generateSubTile's Mercator-space clipper).
      const [tbMxW, tbMyS] = lonLatToMercF64(tb.west, tb.south)
      const [tbMxE, tbMyN] = lonLatToMercF64(tb.east, tb.north)

      scratch.pv.length = 0; scratch.pi.length = 0
      scratch.lv.length = 0; scratch.li.length = 0
      scratch.olv.length = 0; scratch.oli.length = 0
      scratch.ptv.length = 0
      const featureIds = new Set<number>()
      const dedupMap = new Map<string, number>()

      // Lock predicate: vertices on tile boundary edges must survive simplification.
      // Polygons clip in lon/lat, lines clip in Mercator — separate predicates.
      const EPS = 1e-10
      const isOnBoundaryLL = (c: number[]) =>
        Math.abs(c[0] - tb.west) < EPS || Math.abs(c[0] - tb.east) < EPS ||
        Math.abs(c[1] - tb.south) < EPS || Math.abs(c[1] - tb.north) < EPS
      const MERC_EPS = 1.0
      const isOnBoundaryMerc = (c: number[]) =>
        Math.abs(c[0] - tbMxW) < MERC_EPS || Math.abs(c[0] - tbMxE) < MERC_EPS ||
        Math.abs(c[1] - tbMyS) < MERC_EPS || Math.abs(c[1] - tbMyN) < MERC_EPS

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
            const dataRings = z < maxZoom ? simplifyPolygon(clipped, z, isOnBoundaryLL) : clipped
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
            // Emit outline via the line pipeline. Uses the LON/LAT-
            // clipped rings (`clipped`) instead of the original
            // `sp.rings` so outline endpoints exactly match where the
            // fill edges end at the tile boundary — see the fuller
            // explanation on the parallel code path in
            // compileSingleTile (fixed 2026-04-20, same bug).
            for (const ring of clipped) {
              const ringDedup = dedupAdjacentVertices(ring)
              if (ringDedup.length < 3) continue
              const arcRing = augmentRingWithArc(ringDedup)
              if (arcRing.length < 2) continue
              const segments = clipLineToRect(arcRing, tbMxW, tbMyS, tbMxE, tbMyN)
              for (const seg of segments) {
                if (seg.length >= 2) {
                  tessellateLineToArrays(seg, fid, scratch.olv, scratch.oli)
                }
              }
            }
          }
        }

        if (sp.coords) {
          const arcLine = augmentLineWithArc(sp.coords)
          const segments = clipLineToRect(arcLine, tbMxW, tbMyS, tbMxE, tbMyN)
          for (const seg of segments) {
            if (seg.length >= 2) {
              preSimplifyVerts += seg.length
              const dataLine = z < maxZoom ? simplifyLine(seg, z, isOnBoundaryMerc, mercatorToleranceForZoom(z)) : seg
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

        // Point: just check if it's inside the tile bounds
        if (sp.original.type === 'point' && sp.original.point) {
          const [px, py] = sp.original.point
          if (px >= tb.west && px <= tb.east && py >= tb.south && py <= tb.north) {
            scratch.ptv.push(px, py, fid)
            featureIds.add(fid)
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
          scratch.olv.length = 0
          scratch.oli.length = 0
        }
      }

      // Minimum size filter
      const hasGeometry = scratch.pv.length >= 9 || scratch.lv.length >= 8 || scratch.ptv.length >= 3
      if (fullCover || hasGeometry) {

        // The legacy boundary-edge filter that used to drop synthetic
        // tile-boundary outline segments is gone — clipLineToRect (used
        // by the new outline path) doesn't generate those segments in
        // the first place, so there's nothing to filter.

        // DSFUN pack: project scratch vertices (absolute lon/lat) to tile-local
        // Mercator meters in f64, then split into (high, low) f32 pairs.
        const [tileMx, tileMy] = lonLatToMercF64(tb.west, tb.south)

        tiles.set(key, {
          z, x: tx, y: ty,
          tileWest: tb.west,
          tileSouth: tb.south,
          vertices: packDSFUNPolygonVertices(scratch.pv, tileMx, tileMy),
          indices: new Uint32Array(scratch.pi),
          lineVertices: packDSFUNLineVertices(scratch.lv, tileMx, tileMy),
          lineIndices: new Uint32Array(scratch.li),
          outlineIndices: new Uint32Array(0), // deprecated — see CompiledTile docstring
          outlineVertices: scratch.olv.length > 0
            ? packDSFUNLineVertices(scratch.olv, tileMx, tileMy)
            : new Float32Array(0),
          outlineLineIndices: new Uint32Array(scratch.oli),
          pointVertices: scratch.ptv.length > 0 ? packDSFUNPolygonVertices(scratch.ptv, tileMx, tileMy) : undefined,
          featureCount: featureIds.size,
          fullCover,
          fullCoverFeatureId: fullCoverFeatId,
          polygons: tilePolygons.length > 0 ? tilePolygons : undefined,
        })

        // Adaptive subdivision:
        // - Full-cover tiles: always subdivide (original data has coastline/border detail at higher zoom)
        // - Polygon/line tiles: subdivide only if simplification removed vertices
        // - Point-bearing tiles: always subdivide so points spread across finer
        //   tiles at higher zooms (no vertex-simplification metric applies).
        const hasPoints = scratch.ptv.length > 0
        if (z < maxZoom && (fullCover || hasPoints || preSimplifyVerts > postSimplifyVerts)) {
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
  // Mercator tile bounds for line clipping (must match generateSubTile's space)
  const [stMxW, stMyS] = lonLatToMercF64(tb.west, tb.south)
  const [stMxE, stMyN] = lonLatToMercF64(tb.east, tb.north)
  const scratch = { pv: [] as number[], pi: [] as number[], lv: [] as number[], li: [] as number[], ptv: [] as number[], olv: [] as number[], oli: [] as number[] }
  const featureIds = new Set<number>()
  const dedupMap = new Map<string, number>()
  const EPS = 1e-10
  // isOnBoundary: polygons still clip in lon/lat, lines clip in Mercator.
  // For simplifyLine, boundary check uses Mercator coordinates.
  const isOnBoundaryLL = (c: number[]) =>
    Math.abs(c[0] - tb.west) < EPS || Math.abs(c[0] - tb.east) < EPS ||
    Math.abs(c[1] - tb.south) < EPS || Math.abs(c[1] - tb.north) < EPS
  const MERC_EPS = 1.0 // 1 meter tolerance for Mercator boundary detection
  const isOnBoundaryMerc = (c: number[]) =>
    Math.abs(c[0] - stMxW) < MERC_EPS || Math.abs(c[0] - stMxE) < MERC_EPS ||
    Math.abs(c[1] - stMyS) < MERC_EPS || Math.abs(c[1] - stMyN) < MERC_EPS
  const tilePolygons: { rings: number[][][]; featId: number }[] = []

  for (const part of parts) {
    // Quick bbox reject
    if (part.maxLon < tb.west || part.minLon > tb.east ||
        part.maxLat < tb.south || part.minLat > tb.north) continue

    const fid = part.featureIndex

    if (part.type === 'polygon' && part.rings) {
      const clipped = clipPolygonToRect(part.rings, tb.west, tb.south, tb.east, tb.north, precision)
      if (clipped.length > 0 && clipped[0].length >= 3) {
        const dataRings = z < maxZoom ? simplifyPolygon(clipped, z, isOnBoundaryLL) : clipped
        if (dataRings.length > 0 && dataRings[0].length >= 3) {
          tessellatePolygonToArrays(dataRings, fid, scratch.pv, scratch.pi, dedupMap)
          featureIds.add(fid)
          tilePolygons.push({ rings: dataRings, featId: fid })
        }
        // Outline through the line pipeline. Uses `clipped` (the
        // LON/LAT-clipped rings from the fill path above) — NOT the
        // original `part.rings` — so outline endpoints land exactly
        // on the same tile-boundary points the fill edges end at.
        //
        // Historical bug (fixed 2026-04-20): previous code walked
        // `part.rings` and then clipped a second time in Mercator via
        // `clipLineToRect`. For source polygons with edges that span
        // many degrees of latitude (e.g. a triangle vertex at
        // lat=-20 connecting to lat=+30), a straight line in lon/lat
        // is a curve in Mercator, so the two clips produce endpoints
        // that differ by up to tens of km at boundary tiles — fill
        // and stroke end up drawn at geometrically different places.
        // Using the lon/lat-clipped rings keeps the two pipelines
        // aligned to the spec GeoJSON linear-interpolation semantics.
        //
        // Note: augmentRingWithArc restarts arc=0 at each ring, so
        // dash patterns on a polygon split across multiple tiles now
        // desync at tile boundaries for cross-tile arcs. Accepted
        // trade-off: visible stroke/fill alignment matters more than
        // dash phase continuity across tile seams. If cross-tile
        // dash continuity is needed later, the augmenter needs to
        // carry a source-ring-global arc into the clipped ring.
        for (const ring of clipped) {
          // clipPolygonToRect can emit rings that start with a duplicate
          // of the first vertex (Sutherland-Hodgman stitches the
          // closure at the top). Dedup adjacent repeats before
          // augmenting so augmentRingWithArc doesn't produce a
          // degenerate zero-length self-loop segment, which would
          // otherwise poison buildLineSegments' adjacency lookup.
          const ringDedup = dedupAdjacentVertices(ring)
          if (ringDedup.length < 3) continue
          const arcRing = augmentRingWithArc(ringDedup)
          if (arcRing.length < 2) continue
          const segments = clipLineToRect(arcRing, stMxW, stMyS, stMxE, stMyN)
          for (const seg of segments) {
            if (seg.length >= 2) {
              tessellateLineToArrays(seg, fid, scratch.olv, scratch.oli)
            }
          }
        }
      }
    }

    if (part.type === 'line' && part.coords) {
      const arcLine = augmentLineWithArc(part.coords)
      const segments = clipLineToRect(arcLine, stMxW, stMyS, stMxE, stMyN)
      for (const seg of segments) {
        if (seg.length >= 2) {
          const dataLine = z < maxZoom ? simplifyLine(seg, z, isOnBoundaryMerc, mercatorToleranceForZoom(z)) : seg
          if (dataLine.length >= 2) {
            tessellateLineToArrays(dataLine, fid, scratch.lv, scratch.li)
            featureIds.add(fid)
          }
        }
      }
    }

    if (part.type === 'point' && part.point) {
      const [px, py] = part.point
      if (px >= tb.west && px <= tb.east && py >= tb.south && py <= tb.north) {
        scratch.ptv.push(px, py, fid)
        featureIds.add(fid)
      }
    }
  }

  // Full-cover detection: a single feature's single ring fully
  // covers the tile. Mirrors compileGeoJSONToTiles:896-911 so runtime
  // sub-tiles use the same quad-rendering fast path as batch-compiled
  // ones. Without this, sub-tiles in the interior of a large polygon
  // ship with triangulated fill but downstream code paths that key on
  // the fullCover flag (createFullCoverTileData, match() color lookup
  // via the fullCoverFeatureId) never see it — tiles render with
  // missing color when zoomed beyond the pre-compiled level.
  let fullCover = false
  let fullCoverFeatId = -1
  if (tilePolygons.length === 1 && tilePolygons[0].rings.length === 1) {
    const ring = tilePolygons[0].rings[0]
    const tileArea = (tb.east - tb.west) * (tb.north - tb.south)
    const polyArea = Math.abs(shoelaceArea(ring))
    if (tileArea > 0 && Math.abs(polyArea - tileArea) / tileArea < 1e-6) {
      fullCover = true
      fullCoverFeatId = tilePolygons[0].featId
      // Clear polygon + outline scratch — client will generate a quad.
      // Keep line/point scratch: those render independently.
      scratch.pv.length = 0
      scratch.pi.length = 0
      scratch.olv.length = 0
      scratch.oli.length = 0
    }
  }

  if (!fullCover && scratch.pv.length < 9 && scratch.lv.length < 8 && scratch.ptv.length < 3) return null

  // No legacy boundary-edge filter — clipLineToRect (used by the
  // outline path above) doesn't generate synthetic boundary segments.

  // DSFUN pack: project to tile-local Mercator meters, split into high/low pairs
  const [tileMx, tileMy] = lonLatToMercF64(tb.west, tb.south)

  return {
    z, x, y,
    tileWest: tb.west, tileSouth: tb.south,
    vertices: packDSFUNPolygonVertices(scratch.pv, tileMx, tileMy),
    indices: new Uint32Array(scratch.pi),
    lineVertices: packDSFUNLineVertices(scratch.lv, tileMx, tileMy),
    lineIndices: new Uint32Array(scratch.li),
    outlineIndices: new Uint32Array(0), // deprecated — see CompiledTile docstring
    outlineVertices: scratch.olv.length > 0
      ? packDSFUNLineVertices(scratch.olv, tileMx, tileMy)
      : new Float32Array(0),
    outlineLineIndices: new Uint32Array(scratch.oli),
    pointVertices: scratch.ptv.length > 0 ? packDSFUNPolygonVertices(scratch.ptv, tileMx, tileMy) : undefined,
    featureCount: featureIds.size,
    fullCover,
    fullCoverFeatureId: fullCover ? fullCoverFeatId : undefined,
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
    const allParts = decomposeFeatures(geojson.features, options?.idResolver)

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
    const scratch = { pv: [] as number[], pi: [] as number[], lv: [] as number[], li: [] as number[], ptv: [] as number[], olv: [] as number[], oli: [] as number[] }

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

