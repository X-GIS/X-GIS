// ═══ Vector Tiler ═══
// Compiles GeoJSON → pyramid of GPU-ready tiles (COG-style overview levels).
// Per-part decomposition: MultiPolygons are split into individual parts
// with tighter bounding boxes, dramatically reducing tile scatter for large features.

import earcut from 'earcut'
import { simplifyPolygon, simplifyLine, mercatorToleranceForZoom } from './simplify'
import { clipPolygonToRect, clipLineToRect, splitBoundaryBacktracks } from './clip'
import { precisionForZoomMM } from './encoding'
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

/** Quantized polygon vertex stride: Int16×2 (mx, my) + Float32 (fid).
 *  60% smaller than DSFUN_POLY_STRIDE × 4 = 20 bytes. Used by the
 *  vertex-compression pipeline (commit message tag: "Phase B"). The
 *  Int16 coords are normalized to [0, 65535] mapping the [0, tile_
 *  extent_meters] tile-local domain — fixed-constant dequant in the
 *  shader avoids the per-tile uniform overwrite issue that failed the
 *  earlier 245ac66 attempt. */
export const QUANT_POLY_STRIDE_BYTES = 8
export const QUANT_POLY_RANGE = 65535

/** Phase B vertex-compression pack. Equivalent to packDSFUNPolygon-
 *  Vertices but emits Int16×2 + Float32 instead of Float32×5. The
 *  shader dequants via `vec2<f32>(pos_i16) / 65535.0 * tile_extent_m`
 *  where `tile_extent_m` derives from the existing per-tile zoom
 *  uniform (no new uniforms). Precision: tile_extent_m / 65535 ≥
 *  0.146 mm at zoom 22 — sub-pixel even at the finest LOD in the
 *  pyramid. */
export function packQuantizedPolygonVertices(
  scratchPv: number[] | Float64Array,
  tileMx: number,
  tileMy: number,
  tileExtentMeters: number,
): ArrayBuffer {
  // Input stride-3: [mx, my, fid] in absolute Mercator meters (MM).
  // Output stride-8 bytes: Int16 mx_q, Int16 my_q, Float32 fid.
  const count = scratchPv.length / 3
  const buf = new ArrayBuffer(count * QUANT_POLY_STRIDE_BYTES)
  const i16 = new Int16Array(buf)
  const f32 = new Float32Array(buf)
  const scale = QUANT_POLY_RANGE / tileExtentMeters
  for (let i = 0; i < count; i++) {
    const mx = scratchPv[i * 3]
    const my = scratchPv[i * 3 + 1]
    const fid = scratchPv[i * 3 + 2]
    const localMx = mx - tileMx
    const localMy = my - tileMy
    // Quantize to [0, 65535]. Coords outside [0, tileExtentMeters]
    // (rare — clip pipeline keeps them inside) saturate via clamp.
    let mxQ = Math.round(localMx * scale)
    let myQ = Math.round(localMy * scale)
    if (mxQ < 0) mxQ = 0; else if (mxQ > QUANT_POLY_RANGE) mxQ = QUANT_POLY_RANGE
    if (myQ < 0) myQ = 0; else if (myQ > QUANT_POLY_RANGE) myQ = QUANT_POLY_RANGE
    // Int16 max is 32767, but our domain is unsigned [0, 65535]. We
    // store the unsigned 16-bit pattern in the Int16 slot — the
    // shader uses `format: 'unorm16x2'` (or 'uint16x2' + manual
    // normalize) to interpret it correctly. Here we cast via the
    // 16-bit two's-complement representation.
    const i16Idx = i * 4
    i16[i16Idx] = mxQ <= 32767 ? mxQ : mxQ - 65536
    i16[i16Idx + 1] = myQ <= 32767 ? myQ : myQ - 65536
    f32[i * 2 + 1] = fid
  }
  return buf
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
  // Input stride-3: [mx, my, fid] in ABSOLUTE Mercator meters (MM).
  // Output stride-5: [mx_h, my_h, mx_l, my_l, fid] in tile-local MM
  // split across f32 high/low pairs. See docs/COORDINATES.md for the
  // per-stage space rules — all polygon CPU work ends in MM so this
  // function is just re-originating to the tile corner plus DSFUN
  // high/low splitting. Historical note: used to accept lon/lat and
  // project here; the projection was hoisted up to the pipeline
  // entry point (decomposeFeatures → projectRingsToMM) so every
  // intermediate buffer lives in MM.
  const count = scratchPv.length / 3
  const out = new Float32Array(count * 5)
  for (let i = 0; i < count; i++) {
    const mx = scratchPv[i * 3]
    const my = scratchPv[i * 3 + 1]
    const fid = scratchPv[i * 3 + 2]
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

/** Project a lon/lat ring array to Mercator meters (MM). Each output
 *  ring is `[[mx, my], ...]`. Use this at the polygon pipeline entry
 *  so all downstream clip/simplify/tessellate runs in MM (industry
 *  standard — matches Mapbox GL / MapLibre / Tippecanoe). */
export function projectRingsToMM(rings: number[][][]): number[][][] {
  const out: number[][][] = new Array(rings.length)
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]
    const projRing: number[][] = new Array(ring.length)
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i]
      const clamped = Math.max(-DSFUN_LAT_LIMIT, Math.min(DSFUN_LAT_LIMIT, lat))
      const mx = lon * DSFUN_DEG2RAD * DSFUN_EARTH_R
      const my = Math.log(Math.tan(Math.PI / 4 + clamped * DSFUN_DEG2RAD / 2)) * DSFUN_EARTH_R
      projRing[i] = [mx, my]
    }
    out[r] = projRing
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

/** Spread the 22 low bits of `v` into even positions of a 44-bit result.
 *  Hot path — Math.pow inside the loop dominated CPU profile (5 % of
 *  total frame time on Bright). Accumulate the power-of-4 instead. */
function spreadBits22(v: number): number {
  let result = 0
  let pow = 1  // 4^0
  for (let i = 0; i < MAX_TILE_ZOOM; i++) {
    if ((v & (1 << i)) !== 0) result += pow
    pow *= 4
  }
  return result
}

/** Collect bits at positions `startBit`, `startBit+2`, `startBit+4`, … back into a packed integer.
 *  Hot path — `Math.pow + Math.floor + % 2` per iteration burned 17 % of
 *  total CPU time on Bright (748 ms / 4 s). Accumulate the divisor and
 *  use `& 1` for the bit test (works for f64 ints up to 2^32 — when the
 *  divided morton/pow sits in safe int range, integer-cast bit-and is
 *  identical to `% 2`). */
function collectBits22(morton: number, startBit: number): number {
  let result = 0
  // pow = 2^startBit, then ×4 per iteration (skip every other bit).
  let pow = startBit === 0 ? 1 : 2
  for (let i = 0; i < MAX_TILE_ZOOM; i++) {
    // Math.floor(morton / pow) is the high-bits-shifted-down view; the
    // low bit of THAT is the bit at position (2*i + startBit) in morton.
    // Fast path: when (morton / pow) < 2^31, the | 0 cast preserves the
    // bottom bit. When morton ≥ 2^32 (z > 15), fall back to the slower
    // arithmetic form.
    if (pow <= 0x80000000) {
      if (((morton / pow) | 0) & 1) result |= (1 << i)
    } else {
      if (Math.floor(morton / pow) % 2 === 1) result |= (1 << i)
    }
    pow *= 4
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
  // Direct identity: key = 4^z + morton(x, y). Parent at z-1 is
  // 4^(z-1) + morton(x>>1, y>>1). Since morton(x>>1, y>>1) === morton(x, y) >> 2
  // (each interleaved bit-pair encodes one level), and 4^(z-1) = 4^z / 4,
  //   parent = 4^z / 4 + (key - 4^z) / 4 = key / 4.
  // Avoids the O(z) `while (acc * 4 <= key)` loop in `tileKeyUnpack` +
  // the morton encode in `tileKey`, both of which dominated the CPU
  // profile on 80-layer styles (Bright at z=14: tileKeyParent took
  // 12.6 % of total frame time; tileKeyUnpack another 4.5 %, much of
  // it called from this function).
  // Math.floor (not `>>> 2`) because tileKeys span up to ~2^45 at z=22,
  // exceeding the Int32 range that bitshift operates on.
  return Math.floor(key / 4)
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

/** Spherical linear interpolation between two (lon, lat) points. `t=0`
 *  returns the first endpoint, `t=1` the second; intermediate values
 *  follow the great-circle (geodesic) arc on a unit sphere.
 *
 *  Used by `subdivideGreatCircle` to insert intermediate vertices
 *  along a line/ring edge so that downstream tile clipping +
 *  projection produce a curve that hugs the sphere surface under
 *  globe projections (orthographic / azimuthal / stereographic). On
 *  flat projections the sub-segment chords are visually
 *  indistinguishable from the original edge as long as each
 *  sub-segment spans ≤1° of arc, so this is safe to apply globally —
 *  no projection-specific gating needed at compile time. */
function slerpLonLat(lon0: number, lat0: number, lon1: number, lat1: number, t: number): [number, number] {
  const DEG2RAD = Math.PI / 180
  const RAD2DEG = 180 / Math.PI
  const phi0 = lat0 * DEG2RAD, lam0 = lon0 * DEG2RAD
  const phi1 = lat1 * DEG2RAD, lam1 = lon1 * DEG2RAD
  const x0 = Math.cos(phi0) * Math.cos(lam0)
  const y0 = Math.cos(phi0) * Math.sin(lam0)
  const z0 = Math.sin(phi0)
  const x1 = Math.cos(phi1) * Math.cos(lam1)
  const y1 = Math.cos(phi1) * Math.sin(lam1)
  const z1 = Math.sin(phi1)
  const cosOmega = Math.max(-1, Math.min(1, x0 * x1 + y0 * y1 + z0 * z1))
  const omega = Math.acos(cosOmega)
  if (omega < 1e-9) return [lon0, lat0] // collinear / coincident
  const s = Math.sin(omega)
  const a = Math.sin((1 - t) * omega) / s
  const b = Math.sin(t * omega) / s
  const x = a * x0 + b * x1
  const y = a * y0 + b * y1
  const z = a * z0 + b * z1
  return [Math.atan2(y, x) * RAD2DEG, Math.asin(Math.max(-1, Math.min(1, z))) * RAD2DEG]
}

/** Great-circle distance in degrees between two (lon, lat) points. */
function greatCircleDistanceDeg(lon0: number, lat0: number, lon1: number, lat1: number): number {
  const DEG2RAD = Math.PI / 180
  const phi0 = lat0 * DEG2RAD, lam0 = lon0 * DEG2RAD
  const phi1 = lat1 * DEG2RAD, lam1 = lon1 * DEG2RAD
  const cosOmega = Math.max(-1, Math.min(1,
    Math.sin(phi0) * Math.sin(phi1) + Math.cos(phi0) * Math.cos(phi1) * Math.cos(lam1 - lam0)
  ))
  return Math.acos(cosOmega) * 180 / Math.PI
}

/** Insert great-circle intermediate vertices into a line / ring so each
 *  sub-segment spans at most ~1° of arc. Edges shorter than 0.5° are
 *  left as-is (their chord is already indistinguishable from the arc
 *  at any reasonable rendering scale). Edges up to 90° are subdivided
 *  proportionally; truly long edges are capped at 64 sub-segments to
 *  bound vertex bloat.
 *
 *  Closed rings (last vertex == first) stay closed: the loop processes
 *  each consecutive pair, so the trailing closure edge gets the same
 *  treatment.
 *
 *  Without this step a fixture like `[[-30, 0], [30, 0]]` rendered
 *  under orthographic projects to a CHORD that punches through the
 *  globe. Subdivided into ~60 1° sub-edges, the chord-of-each-piece
 *  approximation hugs the sphere surface visually. */
function subdivideGreatCircle(coords: number[][]): number[][] {
  if (coords.length < 2) return coords
  const out: number[][] = [coords[0]]
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1]
    const arcDeg = greatCircleDistanceDeg(a[0], a[1], b[0], b[1])
    if (arcDeg < 0.5) {
      out.push(b)
      continue
    }
    const K = Math.min(64, Math.ceil(arcDeg))
    for (let k = 1; k < K; k++) {
      out.push(slerpLonLat(a[0], a[1], b[0], b[1], k / K))
    }
    out.push(b)
  }
  return out
}

function makePolygonPart(rings: number[][][], featureIndex: number): GeometryPart {
  // BBox is computed in LL (for cheap bbox-reject against LL tile
  // bounds). Rings themselves are pre-projected to MERCATOR METERS
  // so every downstream per-tile compile skips the projection step —
  // matches Tippecanoe / Mapbox's "project once at source load"
  // pattern, and keeps the compileTileOnDemand hot path O(clipped
  // vertices) instead of O(source vertices × tiles).
  //
  // Great-circle subdivision is NOT applied here (only on lines —
  // makeLinePart). Polygons split fill/outline through different
  // paths: outline uses `clipped` (unsimplified), fill uses
  // `dataRings = simplifyPolygon(clipped)` at z<maxZoom. Adding
  // sub-vertices to rings causes simplification to drop them from
  // fill but keep them in outline — outline endpoints land off the
  // fill boundary by hundreds of meters, breaking the d34aed2
  // invariant (visible fill/stroke gap). Polygon globe-surface
  // rendering needs a downstream-pipeline fix (subdivide after
  // simplification, or unify both paths through dataRings) — left
  // for a later commit.
  const bbox = ringsBBox(rings[0])
  const mmRings = projectRingsToMM(rings)
  return { type: 'polygon', rings: mmRings, featureIndex, ...bbox }
}

function makeLinePart(coords: number[][], featureIndex: number): GeometryPart {
  // Same great-circle subdivision as makePolygonPart — see the
  // comment there. Without this, fixtures like `[[-30, 0], [30, 0]]`
  // render as a chord cutting through the orthographic globe.
  const subdivided = subdivideGreatCircle(coords)
  const bbox = coordsBBox(subdivided)
  return { type: 'line', coords: subdivided, featureIndex, ...bbox }
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
//
// Note: the old `latToMercatorY(lat)` helper was removed when
// `tessellatePolygonToArrays` moved to MM-native input (commit
// 5ee001c — industry-standard pipeline). Earcut now runs directly
// on MM coords since all upstream clipping + simplification already
// happens in MM, so the "project-just-for-earcut" step became a
// no-op.

/** Vertex dedup key: quantize x/y to 1e6 (~0.1m) and pack into a
 *  single 53-bit-safe number combined with featureId.
 *
 *  Layout (all integer arithmetic, no string allocation):
 *    qx = (x * 1e6) | 0  → 32-bit signed; offset to non-negative via +2^31
 *    qy = (y * 1e6) | 0  → same
 *    key = (qx + 2^31) * 2^22 + (qy + 2^31 & 0x3FFFFF) ⊕ (fid * 0x9e3779b1)
 *
 *  Strict uniqueness for the (qx, qy, fid) triple isn't guaranteed by
 *  this packing — qy uses only 22 bits, dropping the high bits of any
 *  vertex more than ±2.1m × 2^22 / 1e6 ≈ ±2 billion meters from the
 *  origin (well outside the ±20M MM range used by Web Mercator), so
 *  collisions are mathematically impossible inside the planet.
 *  featureId is folded in via XOR with a 32-bit prime so distinct
 *  features at the same (qx, qy) hash to different cells.
 *
 *  Performance: previously a `${qx},${qy},${fid}` template literal
 *  allocated a new string per vertex (top-3 GC source in PMTiles v4
 *  perf profile). Numeric Map keys avoid both the allocation and the
 *  V8 internal string hash. */
function vertexKey(x: number, y: number, fid: number): string {
  // Pre-MM refactor this was a packed int32 over (x*1e6, y*1e6, fid) —
  // valid when input was LL degrees (±180 → ±1.8e8 fits int32). After
  // the polygon pipeline moved to absolute Mercator meters, x/y range
  // ±2.0e7 m so x*1e6 ≈ ±2e13 OVERFLOWS int32 catastrophically — the
  // `| 0` truncation produced essentially random bits and adjacent
  // vertices collided into shared dedup slots. earcut then received
  // self-intersecting/degenerate index lists and emitted huge wedge
  // triangles spanning entire ocean tiles (visible as triangular
  // artifacts in pmtiles_layered at z=3-5).
  //
  // String key with 1mm quantization (Math.round(coord * 1000)) is
  // unambiguous, collision-free, and only ~2x slower than the broken
  // numeric hash on V8 (Map<string,number> internalises short ASCII
  // strings). Tessellation runs off-thread on the worker pool, so the
  // perf delta is invisible at the frame level.
  return `${Math.round(x * 1000)},${Math.round(y * 1000)},${fid | 0}`
}

// ── Triangle subdivision for non-Mercator projections ─────────────────
// earcut produces triangles whose edges are straight lines in MM. When the
// runtime renders under a non-Mercator projection (orthographic, oblique,
// etc.), the GPU rasterizer linearly interpolates triangle interiors in
// SCREEN space, so a triangle whose vertices span large angular distance
// renders as a screen-space-straight chord instead of curving along the
// surface. The visible artifacts are wedges, antimeridian shortcuts, and
// horizontal stripes at the Mercator clamp.
//
// Densifying the mesh — splitting any triangle whose edge exceeds
// MAX_TRI_DEGREES_FOR_PROJ in lon/lat angular distance into 4 sub-triangles
// at MM midpoints — reduces each chord to a smaller angular span, so the
// per-triangle screen-space approximation tracks the surface closely.
//
// Mirrors the legacy logic in runtime/src/loader/geojson.ts that was lost
// when GeoJSON polygon rendering moved to the tile-based pipeline. Linear
// MM midpoints (not great-circle slerp) are sufficient for the visible
// wedge artifact and stay consistent with the MM-throughout pipeline; a
// future quality pass could swap in geodesic midpoints for high-latitude
// polygons spanning >10° if needed.
const MAX_TRI_DEGREES_FOR_PROJ = 2
const MAX_TRI_SUBDIVIDE_DEPTH = 5

function mmToLonLatDeg(x: number, y: number): [number, number] {
  const lon = (x / DSFUN_EARTH_R) / DSFUN_DEG2RAD
  const lat = (2 * Math.atan(Math.exp(y / DSFUN_EARTH_R)) - Math.PI / 2) / DSFUN_DEG2RAD
  return [lon, lat]
}

/** Get-or-add a vertex (MM coords) into the dedup-mapped output array.
 *  Stride-3 layout: x, y, featureId. Returns the global vertex index. */
function getOrAddVertexMM(
  x: number, y: number, featureId: number,
  outVerts: number[],
  dedupMap: Map<string, number>,
): number {
  const key = vertexKey(x, y, featureId)
  let idx = dedupMap.get(key)
  if (idx === undefined) {
    idx = outVerts.length / 3
    outVerts.push(x, y, featureId)
    dedupMap.set(key, idx)
  }
  return idx
}

/** Recursively split a triangle into 4 at MM midpoints when any edge
 *  exceeds the angular threshold. Adjacent triangles sharing an edge
 *  share the same midpoint via dedupMap, so the densified mesh stays
 *  watertight (no gaps, no T-junctions). */
function subdivideTriangleMM(
  i0: number, i1: number, i2: number,
  featureId: number,
  outVerts: number[],
  outIdx: number[],
  dedupMap: Map<string, number>,
  depth: number,
): void {
  const x0 = outVerts[i0 * 3], y0 = outVerts[i0 * 3 + 1]
  const x1 = outVerts[i1 * 3], y1 = outVerts[i1 * 3 + 1]
  const x2 = outVerts[i2 * 3], y2 = outVerts[i2 * 3 + 1]

  // Fast MM-space early-out: if all edges are clearly below the
  // angular threshold, skip the expensive mmToLonLatDeg projection
  // entirely. 2° lon → 222 km in MM; lat is denser at high latitudes
  // (lat 85: 1° ≈ 1500 km MM) so we use a conservative MM bound that
  // can NEVER exceed 2° in either direction. 50 km MM is below 0.45°
  // lon at any latitude AND below 0.5° lat at lat<85. Any triangle
  // entirely below this skips both projection and subdivision —
  // which is the common case at z>=8 (tile spans <0.7° at z=8).
  const FAST_SKIP_MM = 50_000
  const dx01 = Math.abs(x1 - x0), dy01 = Math.abs(y1 - y0)
  const dx12 = Math.abs(x2 - x1), dy12 = Math.abs(y2 - y1)
  const dx20 = Math.abs(x0 - x2), dy20 = Math.abs(y0 - y2)
  if (
    dx01 < FAST_SKIP_MM && dy01 < FAST_SKIP_MM &&
    dx12 < FAST_SKIP_MM && dy12 < FAST_SKIP_MM &&
    dx20 < FAST_SKIP_MM && dy20 < FAST_SKIP_MM
  ) {
    outIdx.push(i0, i1, i2)
    return
  }

  const [lon0, lat0] = mmToLonLatDeg(x0, y0)
  const [lon1, lat1] = mmToLonLatDeg(x1, y1)
  const [lon2, lat2] = mmToLonLatDeg(x2, y2)
  const d01 = Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0))
  const d12 = Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1))
  const d20 = Math.max(Math.abs(lon0 - lon2), Math.abs(lat0 - lat2))
  const maxEdge = Math.max(d01, d12, d20)

  if (maxEdge <= MAX_TRI_DEGREES_FOR_PROJ || depth >= MAX_TRI_SUBDIVIDE_DEPTH) {
    outIdx.push(i0, i1, i2)
    return
  }

  const m01x = (x0 + x1) * 0.5, m01y = (y0 + y1) * 0.5
  const m12x = (x1 + x2) * 0.5, m12y = (y1 + y2) * 0.5
  const m20x = (x2 + x0) * 0.5, m20y = (y2 + y0) * 0.5
  const i01 = getOrAddVertexMM(m01x, m01y, featureId, outVerts, dedupMap)
  const i12 = getOrAddVertexMM(m12x, m12y, featureId, outVerts, dedupMap)
  const i20 = getOrAddVertexMM(m20x, m20y, featureId, outVerts, dedupMap)

  subdivideTriangleMM(i0, i01, i20, featureId, outVerts, outIdx, dedupMap, depth + 1)
  subdivideTriangleMM(i01, i1, i12, featureId, outVerts, outIdx, dedupMap, depth + 1)
  subdivideTriangleMM(i20, i12, i2, featureId, outVerts, outIdx, dedupMap, depth + 1)
  subdivideTriangleMM(i01, i12, i20, featureId, outVerts, outIdx, dedupMap, depth + 1)
}

function tessellatePolygonToArrays(
  rings: number[][][],
  featureId: number,
  outVerts: number[],
  outIdx: number[],
  dedupMap?: Map<string, number>,
): void {
  // Input rings are in MERCATOR METERS (MM), per docs/COORDINATES.md.
  // Triangle edges are straight in MM — matches GPU rendering so there's
  // no coastline overshoot from earcut working in a different space than
  // the output vertex buffer. Historical note: used to take lon/lat and
  // project to MM internally just for earcut; removed when the whole
  // polygon pipeline moved to MM to match the industry-standard
  // Mapbox GL / MapLibre / Tippecanoe convention.
  const flatCoords: number[] = []
  const holeIndices: number[] = []

  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIndices.push(flatCoords.length / 2)
    for (const coord of rings[r]) {
      flatCoords.push(coord[0], coord[1])
    }
  }

  const earcutIdx = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : undefined)

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
    // Densify each earcut triangle so non-Mercator projections can curve
    // along the surface (see subdivideTriangleMM rationale above).
    for (let t = 0; t < earcutIdx.length; t += 3) {
      subdivideTriangleMM(
        localToGlobal[earcutIdx[t]],
        localToGlobal[earcutIdx[t + 1]],
        localToGlobal[earcutIdx[t + 2]],
        featureId, outVerts, outIdx, dedupMap, 0,
      )
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
function augmentChainWithArc(coords: number[][], closed: boolean, opts?: { mmInput?: boolean }): number[][] {
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

  // Pass 1: project (if input is LL) + accumulate arc. For closed
  // rings, also walk the closing segment so arcArr[n] is the full
  // perimeter. The `mmInput` opt skips projection when the caller has
  // already projected to MM — used by the industry-standard MM-native
  // polygon outline path.
  const mmInput = opts?.mmInput === true
  const mxArr = new Float64Array(n)
  const myArr = new Float64Array(n)
  const arcArr = new Float64Array(outN)
  let arc = 0
  for (let i = 0; i < n; i++) {
    const c = coords[i]
    if (mmInput) {
      mxArr[i] = c[0]
      myArr[i] = c[1]
    } else {
      mxArr[i] = c[0] * DEG2RAD * R
      myArr[i] = Math.log(Math.tan(Math.PI / 4 + clampLat(c[1]) * DEG2RAD / 2)) * R
    }
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
  //
  // Hot-path optimisation: tangent computation is inlined and
  // results land directly into the output 7-tuple — eliminates two
  // 2-element [dx/len, dy/len] allocations per vertex (was the
  // top-3 GC source in PMTiles v4 perf profile).
  const out: number[][] = new Array(outN)
  for (let i = 0; i < n; i++) {
    let tinX = 0, tinY = 0, toutX = 0, toutY = 0
    if (actuallyClosed) {
      const prev = i === 0 ? n - 1 : i - 1
      const next = i === n - 1 ? 0 : i + 1
      const inDx = mxArr[i] - mxArr[prev], inDy = myArr[i] - myArr[prev]
      const inLen = Math.sqrt(inDx * inDx + inDy * inDy)
      if (inLen > 1e-9) { tinX = inDx / inLen; tinY = inDy / inLen }
      const outDx = mxArr[next] - mxArr[i], outDy = myArr[next] - myArr[i]
      const outLen = Math.sqrt(outDx * outDx + outDy * outDy)
      if (outLen > 1e-9) { toutX = outDx / outLen; toutY = outDy / outLen }
    } else {
      if (i > 0) {
        const inDx = mxArr[i] - mxArr[i - 1], inDy = myArr[i] - myArr[i - 1]
        const inLen = Math.sqrt(inDx * inDx + inDy * inDy)
        if (inLen > 1e-9) { tinX = inDx / inLen; tinY = inDy / inLen }
      }
      if (i < n - 1) {
        const outDx = mxArr[i + 1] - mxArr[i], outDy = myArr[i + 1] - myArr[i]
        const outLen = Math.sqrt(outDx * outDx + outDy * outDy)
        if (outLen > 1e-9) { toutX = outDx / outLen; toutY = outDy / outLen }
      }
    }
    out[i] = [mxArr[i], myArr[i], arcArr[i], tinX, tinY, toutX, toutY]
  }
  // Wrap vertex for closed rings: same coords as vertex 0 but
  // arc=perimeter. Tangent_in matches the closing segment (n-1→0),
  // tangent_out matches the first segment (0→1) so the join looks
  // identical to a regular interior join.
  if (actuallyClosed) {
    let tinX = 0, tinY = 0, toutX = 0, toutY = 0
    const inDx = mxArr[0] - mxArr[n - 1], inDy = myArr[0] - myArr[n - 1]
    const inLen = Math.sqrt(inDx * inDx + inDy * inDy)
    if (inLen > 1e-9) { tinX = inDx / inLen; tinY = inDy / inLen }
    if (n > 1) {
      const outDx = mxArr[1] - mxArr[0], outDy = myArr[1] - myArr[0]
      const outLen = Math.sqrt(outDx * outDx + outDy * outDy)
      if (outLen > 1e-9) { toutX = outDx / outLen; toutY = outDy / outLen }
    }
    out[n] = [mxArr[0], myArr[0], arcArr[n], tinX, tinY, toutX, toutY]
  }
  return out
}

/** Polygon ring → arc-augmented chain (closed). Thin shim around
 *  `augmentChainWithArc` for call-site readability. Exported for
 *  runtime sub-tilers that need to derive cross-tile-continuous
 *  outline geometry from `polygons` preserved on a TileData. */
export function augmentRingWithArc(ring: number[][], opts?: { mmInput?: boolean }): number[][] {
  return augmentChainWithArc(ring, true, opts)
}

/** Extract the "interior" arcs of a clipped polygon ring — the
 *  sub-chains whose edges come from the ORIGINAL polygon's boundary,
 *  not the synthetic axis-aligned edges Sutherland-Hodgman added to
 *  close the ring at the tile rect.
 *
 *  WHY THIS EXISTS (bug 2026-04-21, user-reported):
 *    d34aed2 routed polygon OUTLINE emission through the fill's
 *    clipped ring so fill/stroke endpoints would coincide. But the
 *    clipped ring's closure includes edges ALONG the tile border
 *    (v_i → v_{i+1} where BOTH lie on a tile-rect edge). Emitting
 *    those as stroke drew a visible cross-hatch at every tile
 *    boundary whenever a polygon spanned multiple tiles.
 *
 *    The fix is to exclude edges where both endpoints lie on the
 *    tile rect — those are synthetic, and the ORIGINAL polygon
 *    never had a stroke there. The output is a list of open
 *    polylines (each representing a contiguous run of original
 *    polygon edges inside this tile). When the polygon is
 *    entirely inside the tile, a single closed ring is returned.
 */
export function extractNonSyntheticArcs(
  ring: number[][],
  isSameBoundarySide: (a: number[], b: number[]) => boolean,
): number[][][] {
  const n = ring.length
  if (n < 2) return []

  // An edge is "synthetic" when both endpoints lie on the SAME axis
  // of the tile rect — a clip added it to close the ring along that
  // rect edge. "Both on boundary" alone isn't enough: a real polygon
  // edge that crosses the tile enters/exits through the rect, so
  // both endpoints can land on boundary lines but on DIFFERENT sides
  // (e.g. enters at x=west, exits at y=north). Those are real edges
  // of the source polygon and MUST keep rendering as stroke.
  const edgeSynthetic: boolean[] = new Array(n)
  for (let i = 0; i < n; i++) {
    edgeSynthetic[i] = isSameBoundarySide(ring[i], ring[(i + 1) % n])
  }

  // All edges real → original polygon is fully inside the tile.
  // Return the whole CLOSED ring (downstream treats closed=true so
  // the last→first wrap renders, preserving join semantics).
  if (edgeSynthetic.every(s => !s)) return [ring]
  // All edges synthetic → this ring is entirely the tile rect's
  // outline, no source polygon content. Emit nothing.
  if (edgeSynthetic.every(s => s)) return []

  // Find a rotation start: the first edge that is real AND preceded
  // by a synthetic one. That's where an arc begins.
  let start = 0
  for (let i = 0; i < n; i++) {
    if (edgeSynthetic[(i - 1 + n) % n] && !edgeSynthetic[i]) { start = i; break }
  }

  const arcs: number[][][] = []
  let current: number[][] = []
  for (let off = 0; off < n; off++) {
    const i = (start + off) % n
    if (edgeSynthetic[i]) {
      if (current.length >= 2) arcs.push(current)
      current = []
    } else {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      if (current.length === 0) current.push(a)
      current.push(b)
    }
  }
  if (current.length >= 2) arcs.push(current)
  return arcs
}

/** Build the `isSameBoundarySide` predicate for a MM tile rect. */
export function makeSameBoundarySidePredicateMerc(
  mxW: number, myS: number, mxE: number, myN: number, eps: number = 1.0,
): (a: number[], b: number[]) => boolean {
  return (a, b) => {
    // Both on x=mxW (tile west edge)
    if (Math.abs(a[0] - mxW) < eps && Math.abs(b[0] - mxW) < eps) return true
    // Both on x=mxE
    if (Math.abs(a[0] - mxE) < eps && Math.abs(b[0] - mxE) < eps) return true
    // Both on y=myS
    if (Math.abs(a[1] - myS) < eps && Math.abs(b[1] - myS) < eps) return true
    // Both on y=myN
    if (Math.abs(a[1] - myN) < eps && Math.abs(b[1] - myN) < eps) return true
    return false
  }
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

      // Lock predicate: vertices on tile boundary edges must survive
      // simplification. Single MM predicate — polygons + lines + outlines
      // now all clip/simplify in MM (docs/COORDINATES.md).
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
          // Industry-standard MM-native pipeline. sp.rings are already
          // in MM (projected once in makePolygonPart), so the hot
          // path runs: clip → simplify → tessellate all in MM. Both
          // fill and outline share the same clipped ring set, so their
          // endpoints agree by construction.
          const clipped = clipPolygonToRect(sp.rings, tbMxW, tbMyS, tbMxE, tbMyN, precisionForZoomMM(z))
          if (clipped.length > 0 && clipped[0].length >= 3) {
            tileClippedRings.push(...clipped)
            tilePolyFeatureIds.add(fid)
            for (const ring of clipped) preSimplifyVerts += ring.length
            // At maxZoom: use original data (for runtime sub-tiling)
            // Below maxZoom: simplify to reduce vertex count
            const dataRings = z < maxZoom ? simplifyPolygon(clipped, z, isOnBoundaryMerc, mercatorToleranceForZoom(z)) : clipped
            if (z < maxZoom) {
              for (const ring of dataRings) postSimplifyVerts += ring.length
            } else {
              postSimplifyVerts += preSimplifyVerts
            }
            // Sutherland-Hodgman emits a SINGLE ring even when the
            // source polygon enters/exits the rect multiple times —
            // the boundary "stitches" can back-track over each other,
            // producing a self-intersecting ring that earcut renders
            // as overlapping triangles. The repair detects opposing-
            // direction segments on the same rect edge and splits the
            // ring at those points; non-pathological rings are
            // pass-through. Originally surfaced on ne_110m_countries
            // South Korea at z=7 tile (108,49) with 256 % triangle-
            // area coverage (debug-korea-z7-triangulation.test.ts).
            const repairedRings = dataRings.length > 0
              ? dataRings.flatMap(r => splitBoundaryBacktracks(r, tbMxW, tbMyS, tbMxE, tbMyN))
              : []
            if (repairedRings.length > 0 && repairedRings[0]!.length >= 3) {
              for (const subRing of repairedRings) {
                if (subRing.length >= 3) {
                  tessellatePolygonToArrays([subRing], fid, scratch.pv, scratch.pi, dedupMap)
                }
              }
              featureIds.add(fid)
              tilePolygons.push({ rings: repairedRings, featId: fid })
            }
            // Outline: extract the ORIGINAL polygon edges from the
            // clipped ring, dropping the synthetic tile-rect edges
            // Sutherland-Hodgman added for closure. Without this
            // filter every tile boundary renders as a visible stroke
            // wherever a polygon crosses it (user-reported on filter_gdp).
            const isSameBoundarySide = makeSameBoundarySidePredicateMerc(
              tbMxW, tbMyS, tbMxE, tbMyN,
            )
            for (const ring of clipped) {
              const ringDedup = dedupAdjacentVertices(ring)
              if (ringDedup.length < 3) continue
              const interiorArcs = extractNonSyntheticArcs(ringDedup, isSameBoundarySide)
              // If the single emitted arc IS the whole ring (polygon
              // fully inside the tile — no synthetic edges at all),
              // treat as closed so the last→first wrap renders.
              // Otherwise each arc is an open chain clipped at the
              // tile rect.
              const wholeRing = interiorArcs.length === 1 && interiorArcs[0] === ringDedup
              for (const arc of interiorArcs) {
                const augmented = augmentChainWithArc(arc, wholeRing, { mmInput: true })
                if (augmented.length < 2) continue
                const segments = clipLineToRect(augmented, tbMxW, tbMyS, tbMxE, tbMyN)
                for (const seg of segments) {
                  if (seg.length >= 2) {
                    tessellateLineToArrays(seg, fid, scratch.olv, scratch.oli)
                  }
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

        // Point: check bounds in LL (point data is lon/lat) and project
        // to MM before pushing into the scratch buffer so all downstream
        // DSFUN packing runs in MM.
        if (sp.original.type === 'point' && sp.original.point) {
          const [px, py] = sp.original.point
          if (px >= tb.west && px <= tb.east && py >= tb.south && py <= tb.north) {
            const [pmx, pmy] = lonLatToMercF64(px, py)
            scratch.ptv.push(pmx, pmy, fid)
            featureIds.add(fid)
          }
        }
      }

      // Full-cover detection: single feature, single ring, area matches tile.
      // Both areas computed in MM (tileClippedRings are MM per above).
      let fullCover = false
      let fullCoverFeatId = -1
      if (tilePolyFeatureIds.size === 1 && tileClippedRings.length === 1) {
        const tileArea = (tbMxE - tbMxW) * (tbMyN - tbMyS)
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
  const precisionMM = precisionForZoomMM(z)
  // Mercator tile bounds — derived from LL tile bounds via the canonical
  // projection. All polygon / line / outline clipping, simplification,
  // and tessellation happens in MM per docs/COORDINATES.md.
  const [stMxW, stMyS] = lonLatToMercF64(tb.west, tb.south)
  const [stMxE, stMyN] = lonLatToMercF64(tb.east, tb.north)
  const scratch = { pv: [] as number[], pi: [] as number[], lv: [] as number[], li: [] as number[], ptv: [] as number[], olv: [] as number[], oli: [] as number[] }
  const featureIds = new Set<number>()
  const dedupMap = new Map<string, number>()
  const MERC_EPS = 1.0 // 1 meter tolerance for tile-boundary detection
  const isOnBoundaryMerc = (c: number[]) =>
    Math.abs(c[0] - stMxW) < MERC_EPS || Math.abs(c[0] - stMxE) < MERC_EPS ||
    Math.abs(c[1] - stMyS) < MERC_EPS || Math.abs(c[1] - stMyN) < MERC_EPS
  const tilePolygons: { rings: number[][][]; featId: number }[] = []

  for (const part of parts) {
    // Quick bbox reject (bbox in LL, tile bounds in LL — fastest path;
    // the actual clip runs in MM below).
    if (part.maxLon < tb.west || part.minLon > tb.east ||
        part.maxLat < tb.south || part.minLat > tb.north) continue

    const fid = part.featureIndex

    if (part.type === 'polygon' && part.rings) {
      // Industry-standard pipeline (Mapbox GL / MapLibre / Tippecanoe):
      // rings are ALREADY in MM — projected once at makePolygonPart
      // (decomposeFeatures time). Hot path is clip → simplify →
      // tessellate all in MM. Fill and outline share the same clipped
      // ring set so endpoints agree by construction.
      const clipped = clipPolygonToRect(part.rings, stMxW, stMyS, stMxE, stMyN, precisionMM)
      if (clipped.length > 0 && clipped[0].length >= 3) {
        const dataRings = z < maxZoom ? simplifyPolygon(clipped, z, isOnBoundaryMerc, mercatorToleranceForZoom(z)) : clipped
        // See compileGeoJSONToTiles for the back-track repair rationale —
        // splits a self-intersecting clipped ring into clean sub-rings
        // before tessellate. Each sub-ring becomes its own polygon
        // (separate tessellate call) since they represent disconnected
        // interior components.
        const repairedRings = dataRings.length > 0
          ? dataRings.flatMap(r => splitBoundaryBacktracks(r, stMxW, stMyS, stMxE, stMyN))
          : []
        if (repairedRings.length > 0 && repairedRings[0]!.length >= 3) {
          for (const subRing of repairedRings) {
            if (subRing.length >= 3) {
              tessellatePolygonToArrays([subRing], fid, scratch.pv, scratch.pi, dedupMap)
            }
          }
          featureIds.add(fid)
          tilePolygons.push({ rings: repairedRings, featId: fid })
        }
        // Outline shares the MM-clipped rings with the fill — endpoints
        // land on the exact same tile-boundary MM points the fill
        // terminates at, eliminating the fill/stroke alignment bug
        // (d34aed2) at the space-choice level rather than requiring
        // a downstream patch.
        //
        // augmentRingWithArc accepts LL input historically but the
        // clipped rings here are MM. Feed MM directly — augmentRingWithArc
        // branches on `LL_INPUT` via the `mmInput` parameter so the arc
        // projection step is a no-op.
        // See parallel comment on compileGeoJSONToTiles outline path —
        // extract original polygon edges from the clipped ring so
        // synthetic tile-rect edges don't emit visible strokes.
        const isSameBoundarySide = makeSameBoundarySidePredicateMerc(
          stMxW, stMyS, stMxE, stMyN,
        )
        for (const ring of clipped) {
          const ringDedup = dedupAdjacentVertices(ring)
          if (ringDedup.length < 3) continue
          const interiorArcs = extractNonSyntheticArcs(ringDedup, isSameBoundarySide)
          const wholeRing = interiorArcs.length === 1 && interiorArcs[0] === ringDedup
          for (const arc of interiorArcs) {
            const augmented = augmentChainWithArc(arc, wholeRing, { mmInput: true })
            if (augmented.length < 2) continue
            const segments = clipLineToRect(augmented, stMxW, stMyS, stMxE, stMyN)
            for (const seg of segments) {
              if (seg.length >= 2) {
                tessellateLineToArrays(seg, fid, scratch.olv, scratch.oli)
              }
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
        const [pmx, pmy] = lonLatToMercF64(px, py)
        scratch.ptv.push(pmx, pmy, fid)
        featureIds.add(fid)
      }
    }
  }

  // Full-cover detection: ring is MM-clipped, so compute tile area
  // in MM too. (tileArea in LL degrees² vs polyArea in MM m² mismatch
  // is the bug this comment saves future contributors from.)
  let fullCover = false
  let fullCoverFeatId = -1
  if (tilePolygons.length === 1 && tilePolygons[0].rings.length === 1) {
    const ring = tilePolygons[0].rings[0]
    const tileArea = (stMxE - stMxW) * (stMyN - stMyS)
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

