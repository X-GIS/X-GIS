import { describe, it, expect } from 'vitest'
import { buildLineSegments, LINE_SEGMENT_STRIDE_F32 } from './line-segment-build'
import { WGS84, tileEcefCenterFromMerc as sharedTileEcefCenterFromMerc } from '@xgis/shared'
import { lonLatToMercF64, packECEFPolygonVertices, tileEcefCenterFromMerc } from '@xgis/compiler'

const verts2f32 = (v: number[]): Float32Array => new Float32Array(v)

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
//
// SCOPE, precisely: these assertions reconstruct `hi + lo` in JS f64, which is
// exact, so what they validate is the PACKING. The shader recombines the same
// pair in f32, whose floor is the ulp at the RTC magnitude (~1 m on a z2 parent,
// ~0.15 mm at z14) — the same recombination the polygon fill arm performs, which
// is why fill and stroke stay registered to each other. That GPU-side half is
// covered by playground/e2e/_line-ecef-lane-parity.spec.ts; do not read a
// sub-µm result here as a claim about what the GPU reconstructs.

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

  // Every case above passes a SINGLE segment, so `writeEcefLanes(…, off + 20)`
  // and a hardcoded `20` are indistinguishable — the exact shape of the
  // "every test passed offset zero" incident. A 4-segment chain makes the
  // per-segment stride arithmetic load-bearing: with a constant slot, segments
  // 1..3 read back zero and the known-positive magnitude check below fails.
  it('every segment of a chain carries its own lanes (per-segment offset)', () => {
    const pts: [number, number][] = [
      [129.35, 37.5],
      [129.36, 37.51],
      [129.38, 37.53],
      [129.41, 37.56],
      [129.45, 37.6],
    ]
    const verts: number[] = []
    pts.forEach(([lon, lat], i) => {
      const [mx, my] = lonLatToMercF64(lon, lat)
      verts.push(...dsfunVert(mx, my, ORIGIN, i, i * 100))
    })
    const idx: number[] = []
    for (let i = 0; i < pts.length - 1; i++) idx.push(i, i + 1)
    const seg = buildLineSegments(verts2f32(verts), new Uint32Array(idx), 10, ORIGIN)
    expect(seg.length / LINE_SEGMENT_STRIDE_F32).toBe(pts.length - 1)
    for (let s = 0; s < pts.length - 1; s++) {
      for (const ep of [0, 1] as const) {
        const off = s * LINE_SEGMENT_STRIDE_F32
        const mercX = ep === 0 ? seg[off] + seg[off + 4] : seg[off + 2] + seg[off + 6]
        const mercY = ep === 0 ? seg[off + 1] + seg[off + 5] : seg[off + 3] + seg[off + 7]
        const [ex, ey, ez] = ecefFromAbsMerc(mercX + ORIGIN[0], mercY + ORIGIN[1])
        const lanes = segLanes(seg, s, ep)
        expect(Math.abs(lanes[0] - (ex - ANCHOR[0])), `seg${s} ep${ep} x`).toBeLessThan(1e-6)
        expect(Math.abs(lanes[1] - (ey - ANCHOR[1])), `seg${s} ep${ep} y`).toBeLessThan(1e-6)
        expect(Math.abs(lanes[2] - (ez - ANCHOR[2])), `seg${s} ep${ep} z`).toBeLessThan(1e-6)
        expect(Math.hypot(...lanes), `seg${s} ep${ep} not zero-filled`).toBeGreaterThan(1e5)
      }
    }
  })

  // The lane anchor must be the SAME function the polygon packer's caller uses
  // (compiler/src/tiler/vector-tiler.ts), not the same-named @xgis/shared export
  // that resolves its constants through activeBody(). They agree on Earth today;
  // this pins that "one authority" is a fact, not a coincidence of the default
  // body — and names the seam if a body ever makes them diverge.
  it('the lane anchor is the polygon packer authority, not a look-alike', () => {
    const [ax, ay, az] = ANCHOR
    const [sx, sy, sz] = sharedTileEcefCenterFromMerc(ORIGIN[0], ORIGIN[1])
    expect(Math.abs(ax - sx)).toBeLessThan(1e-6)
    expect(Math.abs(ay - sy)).toBeLessThan(1e-6)
    expect(Math.abs(az - sz)).toBeLessThan(1e-6)
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

  // The p0 branch above has a mirror at the p1 end (`f1x/f1y`), and only the p0
  // half was covered — deleting the two `f1x = ex` lines left every gate green
  // while p1's lanes described the PRE-bridge point (tileWidth/256: ~9.5 m at
  // z14, ~39 km at z2). Same construction, other end.
  it('#1245 bridge: the p1 end tracks its extension too', () => {
    const tileW = 1000
    const tileH = 1000
    // p1 sits ON the east boundary → the p1 branch extends it outward (+dir).
    const a = [400, 500, 0, 0, 0, 0, 0, 0, 0, 0]
    const b = [tileW, 500, 0, 0, 0, 0, 0, 0, 0, 0]
    const seg = buildLineSegments(
      new Float32Array([...a, ...b]),
      new Uint32Array([0, 1]),
      10,
      ORIGIN,
      tileW,
      tileH,
    )
    const p1x = seg[2] + seg[6]
    expect(p1x, 'bridge must extend p1 past the tile edge').toBeGreaterThan(tileW)
    const [ex, ey, ez] = ecefFromAbsMerc(p1x + ORIGIN[0], seg[3] + seg[7] + ORIGIN[1])
    const lanes = segLanes(seg, 0, 1)
    expect(Math.abs(lanes[0] - (ex - ANCHOR[0]))).toBeLessThan(1e-6)
    expect(Math.abs(lanes[1] - (ey - ANCHOR[1]))).toBeLessThan(1e-6)
    expect(Math.abs(lanes[2] - (ez - ANCHOR[2]))).toBeLessThan(1e-6)
  })
})
