// ═══ ECEF / DSFUN GPU byte-packing kernels ═══
// Pure serialization layer lifted out of vector-tiler.ts: it turns tile-local /
// absolute Mercator-metre scratch geometry into the EXACT quantized-ECEF /
// DSFUN GPU vertex-buffer byte layouts the WGSL @location attributes read
// (polygon stride-24, line stride-10/11, point stride-9), and computes the
// per-tile ECEF anchor those layouts are relative to. Every export is a pure
// `(scratch[, anchor]) → TypedArray` (no class, no GPU device, no mutable
// module state). The tiler imports these back and calls them unchanged.
//
// A battery of byte-for-byte fuzz tests (ecef-precision-fuzz, ecef-point-
// precision-fuzz, ecef-line-segment-fuzz, dsfun-precision-fuzz) reconstructs
// the exact bytes these functions write and asserts sub-mm round-trip — any
// drift fails deterministically on CPU, no GPU/SwiftShader/screenshot needed.

import { POLYGON_FILL_FORMAT, field } from './polygon-vertex-format'
import { WGS84, quantizeAxis } from '@xgis/shared'

// ═══ DSFUN (Double-Single FUNction) helpers ═══
// Tile vertices are stored as (high, low) f32 pairs of tile-local Mercator
// meters. high + low reconstructs an f64-equivalent value; the shader
// subtracts (pos_h - cam_h) + (pos_l - cam_l) to preserve precision under
// large-magnitude subtraction. See docs/dsfun-refactor-plan.md.

// WGS84 ellipsoid constants — single-sourced from @xgis/shared. The three
// packECEF* functions below used to each hand-mirror A/F/E2/RAD2DEG with a
// "mirrors runtime/.../ecef.ts" comment; they now read this one shared copy.
// (DSFUN_EARTH_R below is a SEPARATE sphere radius for the tile-meter DSFUN
// split — same magnitude, different coordinate frame, left as-is.)
const { A, E2, RAD2DEG } = WGS84

/** Web-Mercator sphere radius (m) for the tile-meter DSFUN split. Exported so
 *  the tiler's `mmToLonLatDeg` inverse shares the SAME radius this module's
 *  forward `lonLatToMercF64` / `projectRingsToMM` use (single source). */
export const DSFUN_EARTH_R = 6378137
/** Degrees→radians for the Mercator forward. Exported alongside DSFUN_EARTH_R. */
export const DSFUN_DEG2RAD = Math.PI / 180
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

/** ECEF tile-corner anchor for `packECEFPolygonVertices` / `packECEFLineSegments`.
 *  WGS84 ellipsoidal math — uses the module-level A/E2 (the SAME constants the
 *  packers use for their per-vertex ECEF forward), so the anchor matches the
 *  packers' own ECEF math by construction. A sphere anchor would leave a ~21 km
 *  constant offset between the anchor and the ellipsoidal per-vertex ECEF,
 *  breaking the sub-mm DSFUN round-trip gated by ecef-precision-fuzz.test.ts.
 *  (Cross-package import of runtime/.../ecef.ts forbidden per AC2c.1.1 — the
 *  compiler keeps its own copy.) */
export function tileEcefCenterFromMerc(
  tileMx: number,
  tileMy: number,
): readonly [number, number, number] {
  const tileLonRad = tileMx / A
  const tileLatRad = 2 * Math.atan(Math.exp(tileMy / A)) - Math.PI / 2
  const sinLat = Math.sin(tileLatRad)
  const cosLat = Math.cos(tileLatRad)
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
  return [
    N * cosLat * Math.cos(tileLonRad),
    N * cosLat * Math.sin(tileLonRad),
    N * (1 - E2) * sinLat,
  ] as const
}

/** Pack ABSOLUTE Mercator-metre point features into ECEF DSFUN stride-9.
 *
 * Phase 2 PR 2d.2 — POINT VS ECEF migration. Point vertices are NOT
 * quantized (Phase 2 PR 2f scope is polygon-position only), so this keeps
 * the legacy stride-9 f32 ECEF-DSFUN layout the point VS reads directly.
 *
 * Camera-relative RTC fix: unlike polygon/line, points from every visible
 * tile merge into ONE draw with a single frame uniform, so they CANNOT carry
 * a per-tile ECEF offset. The DSFUN split is therefore around the ABSOLUTE
 * ECEF position (not tile-relative); the point VS re-centers per frame via
 * (ecefH − camH) + (ecefL − camL) against the camera anchor. This matches the
 * addLayer/render() GeoJSON path, which already stores absolute ECEF DSFUN.
 *
 * Input: stride-3 `[mx, my, fid]` ABSOLUTE Mercator metres.
 * Output: stride-9 Float32Array `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon, abs_lat]`.
 */
export function packECEFPointFeatures(
  scratchPv: number[] | Float64Array,
): Float32Array {
  // WGS84 ellipsoid constants come from the module-level @xgis/shared import.

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
    // Absolute ECEF (no per-tile RTC) — see the header note: points merge into
    // a single draw, so re-centering against the camera happens in the VS.
    const rx = ex
    const ry = ey
    const rz = ez
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

// Offsets derived from the single-source POLYGON_FILL_FORMAT spec so the
// bytes this packer WRITES cannot drift from the WGSL @location attributes /
// host GPUVertexBufferLayout that READ them. stride 24 B = 6 f32 = 12 u16.
const FILL_FLOATS_PER_VERT = POLYGON_FILL_FORMAT.stride / 4   // 6
const FILL_U16_PER_VERT = POLYGON_FILL_FORMAT.stride / 2      // 12
const FILL_FID_FLOAT = field(POLYGON_FILL_FORMAT, 'feature_id').offset / 4  // 3
const FILL_LON_FLOAT = field(POLYGON_FILL_FORMAT, 'abs_lon').offset / 4     // 4
const FILL_LAT_FLOAT = field(POLYGON_FILL_FORMAT, 'abs_lat').offset / 4     // 5

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
  // WGS84 ellipsoid constants come from the module-level @xgis/shared import.

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
  const out = new Float32Array(count * FILL_FLOATS_PER_VERT)
  const u16 = new Uint16Array(out.buffer)
  for (let i = 0; i < count; i++) {
    const [xh, xl] = quantizeAxis(rx[i], halfRange, invSpan)
    const [yh, yl] = quantizeAxis(ry[i], halfRange, invSpan)
    const [zh, zl] = quantizeAxis(rz[i], halfRange, invSpan)
    const u = i * FILL_U16_PER_VERT   // u16 lane base (q_xy lanes 0..3, q_z lanes 4..5)
    u16[u]     = xh
    u16[u + 1] = xl
    u16[u + 2] = yh
    u16[u + 3] = yl
    u16[u + 4] = zh
    u16[u + 5] = zl
    const f = i * FILL_FLOATS_PER_VERT // f32 base
    out[f + FILL_FID_FLOAT] = fids[i]
    out[f + FILL_LON_FLOAT] = lonDeg[i]
    out[f + FILL_LAT_FLOAT] = latDeg[i]
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
 *      (line-segment-build.ts's Method A bake was removed when its
 *      LineSegment stride dropped to 20 floats to match the WGSL struct;
 *      this packer remains a separate, unintegrated PR 2d.1B spike.)
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
  // WGS84 ellipsoid constants come from the module-level @xgis/shared import.

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
