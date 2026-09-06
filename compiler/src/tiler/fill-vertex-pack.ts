// ═══ Polygon fill vertex packing — the one producer of POLYGON_FILL_FORMAT bytes ═══
//
// `polygon-vertex-format.ts` is the single source of truth for the LAYOUT; this
// module is the single source of truth for WRITING it. Two packers feed the same
// `vs_main_ecef`: the ground-tile path (`ecef-packing.ts`) and the polar-cap path
// (`data/src/sources/polar-cap-ecef-pack.ts`), and each used to derive the slot
// offsets and run the quantize/interleave loop itself — the polar-cap copy saying
// so in its own comment, "mirrors the kernel exactly" (#2534 audit S15).
//
// They differ only BEFORE this point: one takes pre-projected Mercator, the other
// projects lon/lat and forwards an unclamped `true_lat` for the rows Mercator
// cannot represent. Both then compute `maxAbs` and run an identical tail, which is
// what lives here.
//
// Offsets are DERIVED from POLYGON_FILL_FORMAT, never hardcoded, so the bytes this
// writes cannot drift from the WGSL @location attributes and the host
// GPUVertexBufferLayout that READ them. stride 28 B = 7 f32 = 14 u16; the f32 tail
// is feature_id/abs_lon/abs_lat/true_lat at floats 3/4/5/6.
//
// (Both copies carried "stride 24 B = 6 f32 = 12 u16" in their prose, contradicting
// the `// 7` and `// 14` on the very next lines: `true_lat` was appended for #398
// and the derivation followed, the comment did not. Corrected here rather than
// moved, so the new single authority is not born with a stale docblock.)

import { quantizeAxis } from '@xgis/shared'
import { POLYGON_FILL_FORMAT, field } from './polygon-vertex-format'

export const FILL_FLOATS_PER_VERT = POLYGON_FILL_FORMAT.stride / 4 // 7
export const FILL_U16_PER_VERT = POLYGON_FILL_FORMAT.stride / 2 // 14
export const FILL_FID_FLOAT = field(POLYGON_FILL_FORMAT, 'feature_id').offset / 4 // 3
export const FILL_LON_FLOAT = field(POLYGON_FILL_FORMAT, 'abs_lon').offset / 4 // 4
export const FILL_LAT_FLOAT = field(POLYGON_FILL_FORMAT, 'abs_lat').offset / 4 // 5
export const FILL_TRUELAT_FLOAT = field(POLYGON_FILL_FORMAT, 'true_lat').offset / 4 // 6

/** Tile-local inputs to {@link packFillVertices}. Every array is indexed 0..count-1. */
export interface FillVertexInputs {
  readonly count: number
  /** ECEF RTC residuals (metres) relative to the tile centre. */
  readonly rx: Float64Array
  readonly ry: Float64Array
  readonly rz: Float64Array
  /** max(|rx|,|ry|,|rz|) over the whole tile — the caller has it from its own pass. */
  readonly maxAbs: number
  /** Tile-local Mercator (vertex_merc − tile_origin_merc), NOT degrees. */
  readonly localMercX: Float64Array
  readonly localMercY: Float64Array
  /** UNCLAMPED latitude in degrees, which the disc (flat_rel) arm projects from (#398). */
  readonly trueLatDeg: Float64Array
  /** `null` = one synthetic feature, so every fid slot is written 0 (the polar cap). */
  readonly fids: Float64Array | null
}

export interface QuantizedFillVertices {
  readonly vertices: Float32Array
  readonly dequantScale: number
  readonly dequantHalf: number
}

/** Quantize tile-local ECEF residuals into the interleaved POLYGON_FILL_FORMAT buffer.
 *
 *  u16×6 position occupies the first 12 bytes via a Uint16Array view of the SAME
 *  buffer (little-endian — matching WebGPU's uint16x4/x2 component order); the f32
 *  tail follows at floats 3..6.
 *
 *  The half-range is symmetric per tile. Its epsilon guards rounding at the extreme
 *  AND a degenerate zero-extent tile (a single vertex at the centre, where `span`
 *  would otherwise be 0 and `invSpan` infinite). 1e-6 m = 1 µm — far below the ≤1 mm
 *  contract and below the 2^32 step at any zoom. */
export function packFillVertices(v: FillVertexInputs): QuantizedFillVertices {
  const halfRange = v.maxAbs + 1e-6
  const span = 2 * halfRange
  const dequantScale = span / 0xffffffff
  const invSpan = 0xffffffff / span

  const out = new Float32Array(v.count * FILL_FLOATS_PER_VERT)
  const u16 = new Uint16Array(out.buffer)
  for (let i = 0; i < v.count; i++) {
    const [xh, xl] = quantizeAxis(v.rx[i], halfRange, invSpan)
    const [yh, yl] = quantizeAxis(v.ry[i], halfRange, invSpan)
    const [zh, zl] = quantizeAxis(v.rz[i], halfRange, invSpan)
    const u = i * FILL_U16_PER_VERT // u16 lane base (q_xy lanes 0..3, q_z lanes 4..5)
    u16[u] = xh
    u16[u + 1] = xl
    u16[u + 2] = yh
    u16[u + 3] = yl
    u16[u + 4] = zh
    u16[u + 5] = zl
    const f = i * FILL_FLOATS_PER_VERT // f32 base
    out[f + FILL_FID_FLOAT] = v.fids === null ? 0 : v.fids[i]
    out[f + FILL_LON_FLOAT] = v.localMercX[i]
    out[f + FILL_LAT_FLOAT] = v.localMercY[i]
    out[f + FILL_TRUELAT_FLOAT] = v.trueLatDeg[i]
  }
  return { vertices: out, dequantScale, dequantHalf: halfRange }
}
