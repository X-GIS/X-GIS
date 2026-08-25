import { describe, it, expect } from 'vitest'
import { buildLineSegments, LINE_SEGMENT_STRIDE_F32 } from './line-segment-build'
import { WGS84, tileEcefCenterFromMerc } from '@xgis/shared'
import { lonLatToMercF64, packECEFPolygonVertices } from '@xgis/compiler'

// ═══ #2089 — ECEF endpoint lanes (slots 20-31): CPU-exact, one authority ═══
//
// buildLineSegments packs each FINAL endpoint's WGS84 ECEF RTC (DSFUN hi/lo)
// against `tileEcefCenterFromMerc(tileOriginMerc)` so the globe vs_line
// positions from the SAME authority as the polygon fill instead of re-deriving
// ECEF through f32 `atan(exp())` in-shader (#2053/#2025 misregistration).
// These tests validate the writer against (a) an independent f64 recompute,
// (b) the polygon packer itself (the cross-path agreement the migration
// exists for), and (c) the #1245 boundary bridge (lanes must describe the
// EXTENDED endpoint the Mercator slots describe, not the pre-bridge input).
// Inputs are shaped like the real caller's (stride-10 DSFUN tile-local, a
// real z2 Korea tile origin) — not offset-0 toys (§12).

const { A, E2 } = WGS84

/** Independent f64 forward — mirrors packECEFPolygonVertices' chain. */
function ecefFromAbsMerc(mx: number, my: number): [number, number, number] {
  const lonRad = mx / A
  const latRad = 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2
  const sinLat = Math.sin(latRad)
  const cosLat = Math.cos(latRad)
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
  return [N * cosLat * Math.cos(lonRad), N * cosLat * Math.sin(lonRad), N * (1 - E2) * sinLat]
}

/** Stride-10 DSFUN vertex from an absolute-Mercator point (the packDSFUN
 *  layout: [mx_h, my_h, mx_l, my_l, fid, arc, tin, tin, tout, tout]). */
function dsfunVert(
  absMx: number,
  absMy: number,
  origin: readonly [number, number],
  fid = 0,
  arc = 0,
): number[] {
  const lx = absMx - origin[0]
  const ly = absMy - origin[1]
  const lxH = Math.fround(lx)
  const lyH = Math.fround(ly)
  return [lxH, lyH, Math.fround(lx - lxH), Math.fround(ly - lyH), fid, arc, 0, 0, 0, 0]
}

// The #2053 repro tile: z2 x3 y1 (west 90°, south 0°) containing the Korea
// east coast. Real overzoom-parent scale — RTC magnitudes in the 1e6 m range.
const ORIGIN = lonLatToMercF64(90, 0)
const ANCHOR = tileEcefCenterFromMerc(ORIGIN[0], ORIGIN[1])

const P0 = lonLatToMercF64(129.35, 37.5)
const P1 = lonLatToMercF64(129.36, 37.51)

function segLanes(seg: Float32Array, s: number, ep: 0 | 1): [number, number, number] {
  const b = s * LINE_SEGMENT_STRIDE_F32 + 20 + ep * 6
  return [seg[b] + seg[b + 3], seg[b + 1] + seg[b + 4], seg[b + 2] + seg[b + 5]]
}

describe('#2089 ECEF endpoint lanes', () => {
  it('lanes reconstruct the f64 ECEF RTC to sub-µm (both endpoints)', () => {
    const v = new Float32Array([
      ...dsfunVert(P0[0], P0[1], ORIGIN),
      ...dsfunVert(P1[0], P1[1], ORIGIN, 0, 100),
    ])
    const seg = buildLineSegments(v, new Uint32Array([0, 1]), 10, ORIGIN)
    for (const ep of [0, 1] as const) {
      // Truth from the SLOTS' own hi+lo (what the shader sees as the segment
      // endpoint) — the lanes must describe that point.
      const off = 0 * LINE_SEGMENT_STRIDE_F32
      const mercX = ep === 0 ? seg[off] + seg[off + 4] : seg[off + 2] + seg[off + 6]
      const mercY = ep === 0 ? seg[off + 1] + seg[off + 5] : seg[off + 3] + seg[off + 7]
      const [ex, ey, ez] = ecefFromAbsMerc(mercX + ORIGIN[0], mercY + ORIGIN[1])
      const lanes = segLanes(seg, 0, ep)
      expect(Math.abs(lanes[0] - (ex - ANCHOR[0]))).toBeLessThan(1e-6)
      expect(Math.abs(lanes[1] - (ey - ANCHOR[1]))).toBeLessThan(1e-6)
      expect(Math.abs(lanes[2] - (ez - ANCHOR[2]))).toBeLessThan(1e-6)
      // Known positive: the RTC magnitude is real (1e5-1e7 m at a z2 tile),
      // so a zero-filled lane cannot sneak through as "agreement".
      expect(Math.hypot(...lanes)).toBeGreaterThan(1e5)
    }
  })

  it('agrees with the polygon packer (one position authority, ≤1 mm)', () => {
    const v = new Float32Array([
      ...dsfunVert(P0[0], P0[1], ORIGIN),
      ...dsfunVert(P1[0], P1[1], ORIGIN),
    ])
    const seg = buildLineSegments(v, new Uint32Array([0, 1]), 10, ORIGIN)
    // Same point through packECEFPolygonVertices (quantized) → dequantize.
    const quant = packECEFPolygonVertices([P0[0], P0[1], 0], ANCHOR, ORIGIN)
    const u16 = new Uint16Array(quant.vertices.buffer)
    const deq = (hi: number, lo: number) =>
      (hi * 65536 + lo) * quant.dequantScale - quant.dequantHalf
    const px = deq(u16[0], u16[1])
    const py = deq(u16[2], u16[3])
    const pz = deq(u16[4], u16[5])
    const lanes = segLanes(seg, 0, 0)
    // Polygon side carries ≤ half a quant step of error; 1 mm bounds both.
    expect(Math.abs(lanes[0] - px)).toBeLessThan(1e-3)
    expect(Math.abs(lanes[1] - py)).toBeLessThan(1e-3)
    expect(Math.abs(lanes[2] - pz)).toBeLessThan(1e-3)
  })

  it('null tileOriginMerc zero-fills the lanes (explicit flat-only opt-out)', () => {
    const v = new Float32Array([
      ...dsfunVert(P0[0], P0[1], ORIGIN),
      ...dsfunVert(P1[0], P1[1], ORIGIN),
    ])
    const seg = buildLineSegments(v, new Uint32Array([0, 1]), 10, null)
    for (let k = 20; k < 32; k++) expect(seg[k]).toBe(0)
  })

  it('#1245 bridge: lanes track the EXTENDED endpoint, not the input', () => {
    // Chain end ON the tile west boundary (local x ≈ 0) → cap suppression
    // extends p0 outward by tileWidth/256. Lanes must match the extended
    // Mercator slots exactly (same recompute as test 1).
    const tileW = 1000
    const tileH = 1000
    const a: number[] = [0, 500, 0, 0, 0, 0, 0, 0, 0, 0] // on boundary
    const b: number[] = [400, 500, 0, 0, 0, 0, 0, 0, 0, 0]
    const v = new Float32Array([...a, ...b])
    const seg = buildLineSegments(v, new Uint32Array([0, 1]), 10, ORIGIN, tileW, tileH)
    const off = 0
    const p0x = seg[off] + seg[off + 4] // extended (−bridge along dir)
    expect(p0x).toBeLessThan(0) // proves the bridge fired
    const [ex, ey, ez] = ecefFromAbsMerc(p0x + ORIGIN[0], seg[off + 1] + seg[off + 5] + ORIGIN[1])
    const lanes = segLanes(seg, 0, 0)
    expect(Math.abs(lanes[0] - (ex - ANCHOR[0]))).toBeLessThan(1e-6)
    expect(Math.abs(lanes[1] - (ey - ANCHOR[1]))).toBeLessThan(1e-6)
    expect(Math.abs(lanes[2] - (ez - ANCHOR[2]))).toBeLessThan(1e-6)
  })
})
