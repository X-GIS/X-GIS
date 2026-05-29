// ═══ Vector Tiler ═══
// Compiles GeoJSON → pyramid of GPU-ready tiles (COG-style overview levels).
// Per-part decomposition: MultiPolygons are split into individual parts
// with tighter bounding boxes, dramatically reducing tile scatter for large features.

import earcut from 'earcut'
import { simplifyPolygon, simplifyLine, mercatorToleranceForZoom } from './simplify'
import { clipPolygonToRect, clipLineToRect, splitBoundaryBacktracks } from './clip'
import { precisionForZoomMM } from './encoding'
import type { GeoJSONFeatureCollection, GeoJSONFeature } from './geojson-types'
import { tileKey, tileKeyUnpack } from './vector-tiler-helpers'
import type {
  CompiledTileSet,
  PropertyTable,
  PropertyFieldType,
  TileLevel,
  CompiledTile,
  GeometryPart,
  FeatureIdResolver,
  TilerOptions,
} from './vector-tiler-types'

// Re-export shared types so the module's public surface is unchanged.
export type {
  CompiledTileSet,
  PropertyTable,
  PropertyFieldType,
  TileLevel,
  CompiledTile,
  GeometryPart,
  FeatureIdResolver,
  TilerOptions,
} from './vector-tiler-types'

// Re-export tile-key helpers so the module's public surface is unchanged.
export {
  mortonEncode,
  mortonDecode,
  tileKey,
  tileKeyUnpack,
  tileKeyParent,
  tileKeyChildren,
} from './vector-tiler-helpers'

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

/** Pack ABSOLUTE Mercator-metre point features into ECEF DSFUN stride-9.
 *
 * Phase 2 PR 2d.2 — POINT VS ECEF migration. Point vertices are NOT
 * quantized (Phase 2 PR 2f scope is polygon-position only), so this keeps
 * the legacy stride-9 f32 ECEF-DSFUN layout the point VS reads directly.
 *
 * Input: stride-3 `[mx, my, fid]` ABSOLUTE Mercator metres.
 * Output: stride-9 Float32Array `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon, abs_lat]`.
 */
export function packECEFPointFeatures(
  scratchPv: number[] | Float64Array,
  ecefTileCenter: readonly [number, number, number],
): Float32Array {
  // WGS84 constants (mirrors runtime/src/engine/projection/ecef.ts).
  const A = 6378137               // semi-major axis (m)
  const F = 1 / 298.257223563     // flattening
  const E2 = F * (2 - F)          // first eccentricity squared
  const RAD2DEG = 180 / Math.PI

  const count = scratchPv.length / 3
  const out = new Float32Array(count * 9)
  for (let i = 0; i < count; i++) {
    const mx = scratchPv[i * 3]
    const my = scratchPv[i * 3 + 1]
    const fid = scratchPv[i * 3 + 2]

    const lon_rad = mx / A
    const lat_rad = 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2
    const sinLat = Math.sin(lat_rad)
    const cosLat = Math.cos(lat_rad)
    const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
    const ex = N * cosLat * Math.cos(lon_rad)
    const ey = N * cosLat * Math.sin(lon_rad)
    const ez = N * (1 - E2) * sinLat
    const rx = ex - ecefTileCenter[0]
    const ry = ey - ecefTileCenter[1]
    const rz = ez - ecefTileCenter[2]
    const exH = Math.fround(rx)
    const eyH = Math.fround(ry)
    const ezH = Math.fround(rz)

    const base = i * 9
    out[base]     = exH
    out[base + 1] = eyH
    out[base + 2] = ezH
    out[base + 3] = Math.fround(rx - exH)
    out[base + 4] = Math.fround(ry - eyH)
    out[base + 5] = Math.fround(rz - ezH)
    out[base + 6] = fid
    out[base + 7] = lon_rad * RAD2DEG
    out[base + 8] = lat_rad * RAD2DEG
  }
  return out
}

/** Per-tile dequantization uniform companion to a quantized polygon vertex
 *  buffer. The GPU VS reconstructs each axis as
 *  `q = f32(hi)*65536 + f32(lo); axis = q * dequantScale - dequantHalf`. */
export interface QuantizedPolygonVertices {
  /** Interleaved bytes: stride 24 = uint16×6 position (12 B) + f32 fid (4 B)
   *  + f32 abs_lon (4 B) + f32 abs_lat (4 B). Backed by a Float32Array view
   *  (stride 6 floats) so the f32 tail lands at float indices 3/4/5 and the
   *  u16 position occupies the first 12 bytes. */
  vertices: Float32Array
  /** `2 * halfRange / 0xFFFFFFFF` — the per-step metre size. */
  dequantScale: number
  /** `halfRange` — half the symmetric per-tile residual span (metres). */
  dequantHalf: number
}

/** ECEF residual half-range fixed-point quantizer (Phase 2 PR 2f).
 *
 * Quantizes one ECEF RTC residual axis into 32-bit fixed point over the
 * symmetric range `[-halfRange, +halfRange]`, then splits into u16 hi/lo:
 *   q  = round((axis + halfRange) / (2*halfRange) * 0xFFFFFFFF)   // u32
 *   hi = q >>> 16   lo = q & 0xFFFF
 * Returns hi, lo as the two u16 lanes. `invSpan = 0xFFFFFFFF / (2*halfRange)`
 * is hoisted by the caller. */
function quantizeAxis(axis: number, halfRange: number, invSpan: number): [number, number] {
  let q = Math.round((axis + halfRange) * invSpan)
  // Clamp into [0, 0xFFFFFFFF] — by construction (halfRange = exact max-abs
  // over the tile's verts + epsilon) no axis exceeds the range, but rounding
  // at the extreme could land at 0x1_0000_0000; clamp defends the cast.
  if (q < 0) q = 0
  else if (q > 0xFFFFFFFF) q = 0xFFFFFFFF
  return [(q >>> 16) & 0xFFFF, q & 0xFFFF]
}

/** Pack ABSOLUTE Mercator-metre polygon vertices into the quantized ECEF
 * layout (Phase 2 PR 2f — double-u16 position).
 *
 * Input: stride-3 `[mx, my, fid]` ABSOLUTE Mercator metres.
 * Output: `{ vertices, dequantScale, dequantHalf }`. `vertices` is a
 * stride-24-byte interleaved buffer:
 *   bytes  0..11  uint16×6 — qx_hi, qx_lo, qy_hi, qy_lo, qz_hi, qz_lo
 *   bytes 12..15  f32      — fid
 *   bytes 16..19  f32      — abs_lon (degrees)
 *   bytes 20..23  f32      — abs_lat (degrees)
 *
 * Per vertex:
 *   1. Inverse Web Mercator → lon/lat radians.
 *   2. Ellipsoidal ECEF (WGS84) at height=0.
 *   3. Subtract ecefTileCenter (tile-anchor RTC).
 *   4. (post-pass) Quantize each axis over the per-tile symmetric half-range
 *      = exact max-abs residual over this tile's verts (+ tiny epsilon).
 *
 * Math constants are duplicated here (not imported from runtime/) because
 * cross-package imports are forbidden in the compiler tiler.  The values
 * are bit-identical to runtime/src/engine/projection/ecef.ts.
 */
export function packECEFPolygonVertices(
  scratchPv: number[] | Float64Array,
  ecefTileCenter: readonly [number, number, number],
): QuantizedPolygonVertices {
  // WGS84 constants (mirrors runtime/src/engine/projection/ecef.ts).
  const A = 6378137               // semi-major axis (m)
  const F = 1 / 298.257223563     // flattening
  const E2 = F * (2 - F)          // first eccentricity squared
  const RAD2DEG = 180 / Math.PI

  const count = scratchPv.length / 3
  // Pass 1: compute ECEF RTC residuals + abs lon/lat; track max-abs residual.
  const rx = new Float64Array(count)
  const ry = new Float64Array(count)
  const rz = new Float64Array(count)
  const lonDeg = new Float64Array(count)
  const latDeg = new Float64Array(count)
  const fids = new Float64Array(count)
  let maxAbs = 0
  for (let i = 0; i < count; i++) {
    const mx = scratchPv[i * 3]
    const my = scratchPv[i * 3 + 1]
    fids[i] = scratchPv[i * 3 + 2]

    const lon_rad = mx / A
    const lat_rad = 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2
    const sinLat = Math.sin(lat_rad)
    const cosLat = Math.cos(lat_rad)
    const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
    const ex = N * cosLat * Math.cos(lon_rad)
    const ey = N * cosLat * Math.sin(lon_rad)
    const ez = N * (1 - E2) * sinLat

    const ax = ex - ecefTileCenter[0]
    const ay = ey - ecefTileCenter[1]
    const az = ez - ecefTileCenter[2]
    rx[i] = ax; ry[i] = ay; rz[i] = az
    lonDeg[i] = lon_rad * RAD2DEG
    latDeg[i] = lat_rad * RAD2DEG

    const m = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(az))
    if (m > maxAbs) maxAbs = m
  }

  // Per-tile symmetric half-range. Epsilon guards rounding at the extreme +
  // a degenerate zero-extent tile (single vertex at the centre). 1e-6 m =
  // 1 µm — far below the ≤1 mm contract and below the 2^32 step at any zoom.
  const halfRange = maxAbs + 1e-6
  const span = 2 * halfRange
  const dequantScale = span / 0xFFFFFFFF
  const invSpan = 0xFFFFFFFF / span

  // Interleaved output: stride 24 bytes = 6 floats. f32 tail at float 3/4/5;
  // u16×6 position in the first 12 bytes via a Uint16Array view of the same
  // buffer (little-endian — matches WebGPU uint16x4/x2 component order).
  const out = new Float32Array(count * 6)
  const u16 = new Uint16Array(out.buffer)
  for (let i = 0; i < count; i++) {
    const [xh, xl] = quantizeAxis(rx[i], halfRange, invSpan)
    const [yh, yl] = quantizeAxis(ry[i], halfRange, invSpan)
    const [zh, zl] = quantizeAxis(rz[i], halfRange, invSpan)
    const u = i * 12          // u16 lane base (6 lanes / vertex)
    u16[u]     = xh
    u16[u + 1] = xl
    u16[u + 2] = yh
    u16[u + 3] = yl
    u16[u + 4] = zh
    u16[u + 5] = zl
    const f = i * 6           // f32 base
    out[f + 3] = fids[i]
    out[f + 4] = lonDeg[i]
    out[f + 5] = latDeg[i]
  }
  return { vertices: out, dequantScale, dequantHalf: halfRange }
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

/** Pack ABSOLUTE Mercator-metre line endpoints into ECEF DSFUN stride-11.
 *
 * Input: stride-8 `[mx, my, featId, arc, tin_x, tin_y, tout_x, tout_y]` —
 * the same scratch shape `packDSFUNLineVertices` already consumes (one
 * entry per endpoint in segment-storage order).
 * Output: stride-11 Float32Array per endpoint:
 *   [ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, abs_lon, abs_lat,
 *    enu_dir_e, enu_dir_n, enu_pad_u]
 *
 * Per endpoint:
 *   1. Inverse Web Mercator → lon/lat radians.
 *   2. Ellipsoidal ECEF (WGS84) at height=0.
 *   3. Subtract ecefTileCenter (RTC — relative-to-center; keeps per-tile
 *      residuals ≤ tile-extent metres so the f32 high half holds the
 *      magnitude).
 *   4. DSFUN split each axis via Math.fround: hi = f32(v), lo = f32(v - hi).
 *   5. Pack abs_lon (degrees) and abs_lat (degrees) at indices 6 + 7.
 *   6. PR 2d.1B additive — Method A per-endpoint ENU-tangent unit vec3 at
 *      slots 8-10. The vec3 encodes the segment's local ENU-frame unit
 *      direction at this endpoint's lon/lat — (east, north, 0). The
 *      consumer (PR 2d.1C `vs_line`) combines this with the corner
 *      (along × dir + across × normal) intent and half_w_m, then applies
 *      `ecef_to_enu_rotation(lon, lat)` to land on the ECEF corner.
 *      Mirrors `runtime/src/core/line-segment-build.ts` Method A bake at
 *      LINE_SEG_OFF_ENU_P0 / _P1 (slots 20-25 of LineSegment storage).
 *
 *      Mercator y is sec(lat)-stretched relative to physical north metres,
 *      so the bake squashes the y-component of (tin / tout) by cos(lat)
 *      before normalising. At endpoints lacking a meaningful tangent
 *      (cap; both tin and tout are 0) the slot is 0-filled — the consumer
 *      treats zero ENU dir as "no corner offset" (cap geometry).
 *
 * ENU-tangent packing rationale: PR 2d.1 Spike 2 (`line-segment-build.test.ts`)
 * pinned Method A at < 3.3e-4 px error at lat=85. Stride-26 (Method A) won
 * vs stride-30 (per-endpoint ENU rotation packed) for hot-path memory.
 *
 * Math constants are duplicated here (not imported from runtime/) because
 * cross-package imports are forbidden in the compiler tiler.  The values
 * are bit-identical to runtime/src/engine/projection/ecef.ts.
 *
 * `packDSFUNLineVertices` is NOT removed — additive PR. Retirement happens
 * in PR 2d.1 main after sub-tile-generator + line-renderer consumers
 * migrate to ECEF. Tiler call-site swap is deferred to PR 2d.1C — `buildLineSegments`
 * reads stride-10 DSFUN per-vertex layout with feat_id at slot 4; the new
 * stride-11 ECEF layout has ey_l at slot 4 — direct swap would corrupt
 * the heights/widths/colors lookups. See .omc/handoffs/pr2d1b-blocker.md.
 */
export function packECEFLineSegments(
  scratchLv: number[] | Float64Array,
  ecefTileCenter: readonly [number, number, number],
): Float32Array {
  // WGS84 constants (mirrors runtime/src/engine/projection/ecef.ts).
  const A = 6378137               // semi-major axis (m)
  const F = 1 / 298.257223563     // flattening
  const E2 = F * (2 - F)          // first eccentricity squared
  const RAD2DEG = 180 / Math.PI

  const IN_STRIDE = 8   // [mx, my, featId, arc, tin_x, tin_y, tout_x, tout_y]
  const OUT_STRIDE = 11 // [ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, abs_lon, abs_lat, enu_dir_e, enu_dir_n, enu_pad_u]
  const count = scratchLv.length / IN_STRIDE
  const out = new Float32Array(count * OUT_STRIDE)
  for (let i = 0; i < count; i++) {
    const si = i * IN_STRIDE
    const mx = scratchLv[si]
    const my = scratchLv[si + 1]

    // Inverse Web Mercator → lon/lat radians.
    const lon_rad = mx / A
    const lat_rad = 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2

    // WGS84 ellipsoidal ECEF at height = 0.
    const sinLat = Math.sin(lat_rad)
    const cosLat = Math.cos(lat_rad)
    const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
    const ex = N * cosLat * Math.cos(lon_rad)
    const ey = N * cosLat * Math.sin(lon_rad)
    const ez = N * (1 - E2) * sinLat

    // Subtract tile-anchor ECEF center (RTC).
    const rx = ex - ecefTileCenter[0]
    const ry = ey - ecefTileCenter[1]
    const rz = ez - ecefTileCenter[2]

    // DSFUN split: hi = f32(v), lo = f32(v - hi).
    const exH = Math.fround(rx)
    const eyH = Math.fround(ry)
    const ezH = Math.fround(rz)
    const exL = Math.fround(rx - exH)
    const eyL = Math.fround(ry - eyH)
    const ezL = Math.fround(rz - ezH)

    // Absolute geographic coordinates in degrees (for varyings).
    const lon_deg = lon_rad * RAD2DEG
    const lat_deg = lat_rad * RAD2DEG

    // ── PR 2d.1B: per-endpoint ENU-tangent unit vec3 ─────────────────────
    // tin / tout are Mercator-frame unit tangents the tiler computed
    // upstream in `augmentLineWithArc`. We prefer `tout` (outgoing) when
    // it's non-zero; fall back to `tin` (incoming). Either being zero
    // indicates a cap endpoint — output (0, 0, 0).
    let tx = scratchLv[si + 6]
    let ty = scratchLv[si + 7]
    if (tx === 0 && ty === 0) {
      tx = scratchLv[si + 4]
      ty = scratchLv[si + 5]
    }
    let enuDirE = 0
    let enuDirN = 0
    if (tx !== 0 || ty !== 0) {
      // Squash y by cos(lat) to convert Mercator-stretched direction
      // back to ENU-frame north metres, then renormalise.
      const tyEnu = ty * cosLat
      const len = Math.hypot(tx, tyEnu)
      if (len > 1e-9) {
        enuDirE = tx / len
        enuDirN = tyEnu / len
      }
    }

    const di = i * OUT_STRIDE
    out[di]     = exH
    out[di + 1] = eyH
    out[di + 2] = ezH
    out[di + 3] = exL
    out[di + 4] = eyL
    out[di + 5] = ezL
    out[di + 6] = lon_deg
    out[di + 7] = lat_deg
    out[di + 8] = enuDirE
    out[di + 9] = enuDirN
    out[di + 10] = 0  // up-component reserved (Method A across-offset is
                     //  computed VS-side via cross(up, dir); the up axis
                     //  emerges from the ENU rotation matrix the VS forms
                     //  from (lon, lat) — no need to bake it here).
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

// ═══ Geometry Part ═══
// `GeometryPart` + `FeatureIdResolver` types live in vector-tiler-types.ts.

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

/** Even-odd-rule point-in-polygon test for a single ring. Returns
 *  true when (x, y) is strictly inside `ring`, false otherwise.
 *  Boundary classification is technically undefined per the
 *  algorithm; in practice the caller (hole-distribution loop in
 *  compileSingleTile) tests the hole's first vertex which is
 *  always interior to the source polygon, so boundary cases don't
 *  fire. */
function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!
    const xj = ring[j]![0]!, yj = ring[j]![1]!
    // Ray from (x, y) extending right (positive X). Edge crosses
    // iff its endpoints straddle the ray's Y AND the intersection X
    // is to the right of `x`.
    const crosses = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
    if (crosses) inside = !inside
  }
  return inside
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

// lonLatDegToMM was the inverse of mmToLonLatDeg used by
// geodesicMidpointMM (iter 6, reverted iter 56). Removed with the
// geodesicMidpointMM revert; the slerp / Mercator round-trip
// pattern stays documented in the iter-56 commit body for any
// future projection-aware refinement.

/** Geodesic midpoint of two MM points: project both to lon/lat,
 *  slerp on the sphere at t=0.5, project back to MM. Used when a
 *  triangle's edges span enough latitude/longitude that the linear
 *  MM midpoint diverges visibly from the great-circle midpoint on
 *  globe / orthographic / stereographic projections (z=0..3 country
 *  polygons). For small edges the linear midpoint is already
 *  indistinguishable from slerp; the caller gates via edge span.
 *  Slerp is symmetric in t=0.5 so adjacent triangles sharing an edge
 *  produce identical midpoints — dedupMap keeps the mesh watertight. */
// NOTE: geodesicMidpointMM removed in iter 56 — iter 6 introduction
// caused z=0 banding artefacts on production deploy that iter 41's
// 60°-cap didn't fully fix. Reverted to pre-iter-6 linear-midpoint
// behaviour. Helper definition kept inline for reference if a
// future runtime-projection-aware refinement lands.
/*
function geodesicMidpointMM(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const [lon0, lat0] = mmToLonLatDeg(x0, y0)
  const [lon1, lat1] = mmToLonLatDeg(x1, y1)
  const [mLon, mLat] = slerpLonLat(lon0, lat0, lon1, lat1, 0.5)
  return lonLatDegToMM(mLon, mLat)
}
*/

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

  // Linear MM midpoint — matches the pre-iter-6 baseline that was
  // shipped to production without z=0 banding artefacts. Iter 6
  // added geodesic (slerp) midpoint for sphere projections (globe /
  // ortho / azimuth / stereo) but introduced regressions at z=0
  // Mercator (user-reported on x-gis.github.io, iter 56). Iter 41
  // capped the slerp to (5°, 60°) but the regression persisted in
  // deploy. Reverting to linear midpoint entirely — the chord-vs-
  // arc fidelity loss on globe was the documented acceptable
  // baseline before iter 6 anyway. Plan §6 (geodesic refinement)
  // deferred until a robust runtime-projection-aware path lands.
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

/** Detect whether Sutherland-Hodgman's clipped output ring would cause
 *  earcut to produce overlapping triangles — the failure mode the
 *  `splitBoundaryBacktracks` repair was written for. The test runs a
 *  cheap probe-earcut on the outer ring (with holes treated as negative
 *  regions per earcut's contract) and compares the triangle-area sum
 *  to the polygon's signed area. A self-touching ring produces ≥ 1.5×
 *  coverage (Korea z=7's canonical case is 2.57×). A clean complex
 *  polygon — even a heavily non-convex coastline like demotiles z=6
 *  China — produces ≈ 1.00× coverage.
 *
 *  Returns true when the outer ring has visible self-overlap (caller
 *  should apply the splitter repair); false when earcut would produce
 *  a clean tessellation without help (caller should pass the ring
 *  through unchanged). The cost is one earcut call, which we already
 *  pay during the real tessellation — the probe earcut is a small
 *  overhead specific to this safety check.
 */
function needsBacktrackRepair(outer: number[][], holes: number[][][]): boolean {
  const flat: number[] = []
  const holeIdx: number[] = []
  for (const p of outer) flat.push(p[0]!, p[1]!)
  for (const hole of holes) {
    holeIdx.push(flat.length / 2)
    for (const p of hole) flat.push(p[0]!, p[1]!)
  }
  const idx = earcut(flat, holeIdx.length > 0 ? holeIdx : undefined)
  let triArea = 0
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]! * 2, i1 = idx[t + 1]! * 2, i2 = idx[t + 2]! * 2
    triArea += Math.abs(
      (flat[i1]! - flat[i0]!) * (flat[i2 + 1]! - flat[i0 + 1]!)
      - (flat[i2]! - flat[i0]!) * (flat[i1 + 1]! - flat[i0 + 1]!),
    ) * 0.5
  }
  let ringArea = 0
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    ringArea += (outer[j]![0]! - outer[i]![0]!) * (outer[j]![1]! + outer[i]![1]!)
  }
  ringArea = Math.abs(ringArea / 2)
  for (const hole of holes) {
    let a = 0
    for (let i = 0, j = hole.length - 1; i < hole.length; j = i++) {
      a += (hole[j]![0]! - hole[i]![0]!) * (hole[j]![1]! + hole[i]![1]!)
    }
    ringArea -= Math.abs(a / 2)
  }
  if (ringArea <= 0) return false
  // 1.2× threshold: anything materially over 1.0 means earcut produced
  // overlapping triangles. The Korea regression's broken case is 2.57×;
  // China z=6 is 1.00× to floating-point precision. 1.2 sits well
  // above realistic numerical noise from the simplify + clip pipeline.
  return triArea / ringArea > 1.2
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
// `TilerOptions` type lives in vector-tiler-types.ts.

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
            // Sutherland-Hodgman can emit a self-touching ring when the
            // source polygon enters/exits the tile rect multiple times.
            // Run the back-track repair, but only KEEP its split output
            // when earcut on the un-split ring would actually produce
            // overlapping triangles. The triangle-area-vs-ring-area
            // check distinguishes a TRUE clipper artifact (Korea z=7,
            // coverage ~2.57) from a legitimate complex coastline
            // (demotiles z=6 China, coverage ~1.00 — the splitter
            // would otherwise destroy the Yangtze river concavity by
            // chord-cutting through it).
            if (dataRings.length > 0 && dataRings[0]!.length >= 3) {
              const holes = dataRings.slice(1).filter(r => r.length >= 3)
              const acceptSplit = needsBacktrackRepair(dataRings[0]!, holes)
              if (!acceptSplit) {
                const repairedRings = [dataRings[0]!, ...holes]
                tessellatePolygonToArrays(repairedRings, fid, scratch.pv, scratch.pi, dedupMap)
                featureIds.add(fid)
                tilePolygons.push({ rings: repairedRings, featId: fid })
              } else {
                const outerSubs = splitBoundaryBacktracks(dataRings[0]!, tbMxW, tbMyS, tbMxE, tbMyN)
                const usableOuters = outerSubs.filter(r => r.length >= 3)
                const effectiveOuters = usableOuters.length > 0 ? usableOuters : [dataRings[0]!]
                if (effectiveOuters.length === 1) {
                  const repairedRings = [effectiveOuters[0]!, ...holes]
                  tessellatePolygonToArrays(repairedRings, fid, scratch.pv, scratch.pi, dedupMap)
                  featureIds.add(fid)
                  tilePolygons.push({ rings: repairedRings, featId: fid })
                } else {
                  // Distribute holes via point-in-polygon — each clipper
                  // sub-outer gets only the holes that fall inside it.
                  const subHoles: number[][][][] = effectiveOuters.map(() => [])
                  for (const hole of holes) {
                    const px = hole[0]![0]!
                    const py = hole[0]![1]!
                    for (let si = 0; si < effectiveOuters.length; si++) {
                      if (pointInRing(px, py, effectiveOuters[si]!)) {
                        subHoles[si]!.push(hole)
                        break
                      }
                    }
                  }
                  const allRingsForFeature: number[][][] = []
                  for (let si = 0; si < effectiveOuters.length; si++) {
                    const subRings = [effectiveOuters[si]!, ...subHoles[si]!]
                    tessellatePolygonToArrays(subRings, fid, scratch.pv, scratch.pi, dedupMap)
                    for (const r of subRings) allRingsForFeature.push(r)
                  }
                  featureIds.add(fid)
                  tilePolygons.push({ rings: allRingsForFeature, featId: fid })
                }
              }
            }
            // Outline: treat each ORIGINAL ring as a closed
            // LineString and line-clip to the tile rect (MapLibre
            // approach). Line-clipping doesn't introduce synthetic
            // axis-aligned edges, so the outline buffer is free of
            // tile-rect artifacts by construction — no need for
            // extractNonSyntheticArcs filtering.
            for (const ring of sp.rings) {
              if (ring.length < 2) continue
              const augmented = augmentRingWithArc(ring, { mmInput: true })
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

        // ECEF tile-corner anchor for `packECEFPolygonVertices`. WGS84
        // ellipsoidal math — must match `packECEFPolygonVertices` and
        // `runtime/src/engine/projection/ecef.ts:tileEcefCenterFromMerc`
        // byte-for-byte (cross-package import forbidden per AC2c.1.1).
        // Sphere math would leave a ~21 km constant offset between the
        // anchor and the ellipsoidal per-vertex ECEF, breaking the
        // sub-mm DSFUN round-trip gated by ecef-precision-fuzz.test.ts.
        const tileEcefCenter = (() => {
          const A_ = 6378137
          const F_ = 1 / 298.257223563
          const E2_ = F_ * (2 - F_)
          const tileLonRad = tileMx / A_
          const tileLatRad = 2 * Math.atan(Math.exp(tileMy / A_)) - Math.PI / 2
          const sinLat = Math.sin(tileLatRad)
          const cosLat = Math.cos(tileLatRad)
          const N = A_ / Math.sqrt(1 - E2_ * sinLat * sinLat)
          return [
            N * cosLat * Math.cos(tileLonRad),
            N * cosLat * Math.sin(tileLonRad),
            N * (1 - E2_) * sinLat,
          ] as const
        })()

        const quantPv = packECEFPolygonVertices(scratch.pv, tileEcefCenter)
        tiles.set(key, {
          z, x: tx, y: ty,
          tileWest: tb.west,
          tileSouth: tb.south,
          vertices: quantPv.vertices,
          dequantScale: quantPv.dequantScale,
          dequantHalf: quantPv.dequantHalf,
          indices: new Uint32Array(scratch.pi),
          lineVertices: packDSFUNLineVertices(scratch.lv, tileMx, tileMy),
          lineIndices: new Uint32Array(scratch.li),
          outlineIndices: new Uint32Array(0), // deprecated — see CompiledTile docstring
          outlineVertices: scratch.olv.length > 0
            ? packDSFUNLineVertices(scratch.olv, tileMx, tileMy)
            : new Float32Array(0),
          outlineLineIndices: new Uint32Array(scratch.oli),
          pointVertices: scratch.ptv.length > 0 ? packECEFPointFeatures(scratch.ptv, tileEcefCenter) : undefined,
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
        // Repair self-intersecting OUTER ring only — but only when an
        // earcut probe actually detects the overlap. See
        // `needsBacktrackRepair` for the coverage-based detection.
        if (dataRings.length > 0 && dataRings[0]!.length >= 3) {
          const holes = dataRings.slice(1).filter(r => r.length >= 3)
          const acceptSplit = needsBacktrackRepair(dataRings[0]!, holes)
          if (!acceptSplit) {
            const repairedRings = [dataRings[0]!, ...holes]
            tessellatePolygonToArrays(repairedRings, fid, scratch.pv, scratch.pi, dedupMap)
            featureIds.add(fid)
            tilePolygons.push({ rings: repairedRings, featId: fid })
          } else {
            const outerSubs = splitBoundaryBacktracks(dataRings[0]!, stMxW, stMyS, stMxE, stMyN)
            const usableOuters = outerSubs.filter(r => r.length >= 3)
            const effectiveOuters = usableOuters.length > 0 ? usableOuters : [dataRings[0]!]
            if (effectiveOuters.length === 1) {
              const repairedRings = [effectiveOuters[0]!, ...holes]
              tessellatePolygonToArrays(repairedRings, fid, scratch.pv, scratch.pi, dedupMap)
              featureIds.add(fid)
              tilePolygons.push({ rings: repairedRings, featId: fid })
            } else {
              const subHoles: number[][][][] = effectiveOuters.map(() => [])
              for (const hole of holes) {
                const px = hole[0]![0]!
                const py = hole[0]![1]!
                for (let si = 0; si < effectiveOuters.length; si++) {
                  if (pointInRing(px, py, effectiveOuters[si]!)) {
                    subHoles[si]!.push(hole)
                    break
                  }
                }
              }
              const allRingsForFeature: number[][][] = []
              for (let si = 0; si < effectiveOuters.length; si++) {
                const subRings = [effectiveOuters[si]!, ...subHoles[si]!]
                tessellatePolygonToArrays(subRings, fid, scratch.pv, scratch.pi, dedupMap)
                for (const r of subRings) allRingsForFeature.push(r)
              }
              featureIds.add(fid)
              tilePolygons.push({ rings: allRingsForFeature, featId: fid })
            }
          }
        }
        // Outline emission: treat each ORIGINAL ring as a closed
        // LineString and line-clip to the tile rect. This is what
        // MapLibre does for `type:line` layers on a polygon source —
        // line-clipping (Liang-Barsky) doesn't introduce synthetic
        // axis-aligned tile-rect edges the way Sutherland-Hodgman
        // polygon-clipping does, so the outline buffer is free of
        // boundary-coincident artifacts by construction. No
        // `extractNonSyntheticArcs` filter, no synthetic-edge
        // detection — geometry is preserved if and only if it was a
        // real edge of the source polygon.
        //
        // Trade-off vs the prior `clipped`-based path: outline
        // endpoints land where the ORIGINAL ring crossed the tile
        // boundary, which is geometrically identical to the
        // polygon-clipped intersection points (both Liang-Barsky and
        // Sutherland-Hodgman produce the same crossing). So fill /
        // stroke endpoints still agree by construction.
        for (const ring of part.rings) {
          if (ring.length < 2) continue
          const augmented = augmentRingWithArc(ring, { mmInput: true })
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

  // ECEF tile-corner anchor for `packECEFPolygonVertices`. See the
  // matching block in `compileGeoJSONToTiles` for the WGS84-vs-sphere
  // rationale (must match `packECEFPolygonVertices` for sub-mm
  // DSFUN reconstruction).
  const tileEcefCenter = (() => {
    const A_ = 6378137
    const F_ = 1 / 298.257223563
    const E2_ = F_ * (2 - F_)
    const tileLonRad = tileMx / A_
    const tileLatRad = 2 * Math.atan(Math.exp(tileMy / A_)) - Math.PI / 2
    const sinLat = Math.sin(tileLatRad)
    const cosLat = Math.cos(tileLatRad)
    const N = A_ / Math.sqrt(1 - E2_ * sinLat * sinLat)
    return [
      N * cosLat * Math.cos(tileLonRad),
      N * cosLat * Math.sin(tileLonRad),
      N * (1 - E2_) * sinLat,
    ] as const
  })()

  const quantPv = packECEFPolygonVertices(scratch.pv, tileEcefCenter)
  return {
    z, x, y,
    tileWest: tb.west, tileSouth: tb.south,
    vertices: quantPv.vertices,
    dequantScale: quantPv.dequantScale,
    dequantHalf: quantPv.dequantHalf,
    indices: new Uint32Array(scratch.pi),
    lineVertices: packDSFUNLineVertices(scratch.lv, tileMx, tileMy),
    lineIndices: new Uint32Array(scratch.li),
    outlineIndices: new Uint32Array(0), // deprecated — see CompiledTile docstring
    outlineVertices: scratch.olv.length > 0
      ? packDSFUNLineVertices(scratch.olv, tileMx, tileMy)
      : new Float32Array(0),
    outlineLineIndices: new Uint32Array(scratch.oli),
    pointVertices: scratch.ptv.length > 0 ? packECEFPointFeatures(scratch.ptv, tileEcefCenter) : undefined,
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

