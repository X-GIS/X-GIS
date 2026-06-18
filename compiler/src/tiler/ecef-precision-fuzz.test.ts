// Phase 2 PR 2c.1/2c.2 — AC2c.1.1 + AC2c.2.3 verification.
//
// Round-trip precision gate for packECEFPolygonVertices:
//   Mercator (mx, my) → pack stride-9 → reconstruct ECEF f64 → inverse to
//   lon/lat → compare to source lon/lat derived from (mx, my).
//
// GPU reconstruction: ex_f64 = f64(ex_h) + f64(ex_l) + ecefTileCenter[0].
// Inverse ECEF → lon/lat via Bowring iteration (mirrors ecef.ts:45-64).
//
// Precision gates (per AC2c.1.1):
//   z=22 — ≤ 1 mm arc-length on the ellipsoid surface
//   z=0  — ≤ 1 cm arc-length
//
// AC2c.2.3: abs_lon/abs_lat packed at stride-9 indices 7+8 match Mercator
//   inverse to better than 1e-9 degrees.

import { describe, it, expect } from 'vitest'
import { packECEFPolygonVertices } from './ecef-packing'
import { dequantVertex, dequantVertexF32 } from './dequant-mirror'

// ── WGS84 constants (mirrors runtime/src/engine/projection/ecef.ts) ─────────
const A = 6378137               // semi-major axis (m)
const F = 1 / 298.257223563
const E2 = F * (2 - F)          // first eccentricity squared
const DEG2RAD = Math.PI / 180

// ── Deterministic LCG RNG ────────────────────────────────────────────────────
function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s |= 0
    s ^= s >>> 17
    s ^= s << 5;  s |= 0
    return (s >>> 0) / 0x1_0000_0000
  }
}

// ── Coordinate helpers (all inlined — no cross-package imports) ──────────────

/** Web Mercator (m) → lon (rad), lat (rad) */
function mercatorToLonLatRad(mx: number, my: number): [number, number] {
  return [mx / A, 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2]
}

/** lon/lat (rad) → WGS84 ECEF (m) at height=0 */
function lonLatRadToECEF(lon: number, lat: number): [number, number, number] {
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
  return [
    N * cosLat * Math.cos(lon),
    N * cosLat * Math.sin(lon),
    N * (1 - E2) * sinLat,
  ]
}

/** WGS84 ECEF (m) → lon (rad), lat (rad) via Bowring iteration (4 iters) */
function ecefToLonLatRad(x: number, y: number, z: number): [number, number] {
  const lon = Math.atan2(y, x)
  const p = Math.hypot(x, y)
  let lat = Math.atan2(z, p * (1 - E2))
  let N = A
  let height = 0
  for (let i = 0; i < 4; i++) {
    const sinLat = Math.sin(lat)
    N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
    height = p / Math.cos(lat) - N
    const newLat = Math.atan2(z, p * (1 - (E2 * N) / (N + height)))
    if (Math.abs(newLat - lat) < 1e-12) { lat = newLat; break }
    lat = newLat
  }
  return [lon, lat]
}

/** Arc-length (metres) between two lon/lat (rad) pairs on WGS84 sphere
 *  approximation (A = 6378137).  Good enough for sub-cm gate checks. */
function arcLengthM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLon = (lon2 - lon1) * Math.cos((lat1 + lat2) / 2)
  const dLat = lat2 - lat1
  return A * Math.hypot(dLon, dLat)
}

/** Tile extent in Mercator metres at zoom level z (one tile side). */
function tileExtentM(z: number): number {
  return (2 * Math.PI * A) / Math.pow(2, z)
}

// ── Core helper: pack one point and measure reconstruction error ─────────────
//
// dequantVertex (f64, encoder intent) + dequantVertexF32 (GPU-faithful f32)
// live in ./dequant-mirror so the compute parity harness (_dequant-parity)
// shares the EXACT same CPU mirror it validates against the real GPU.

function roundTripError(
  mx: number,
  my: number,
  ecefCenter: readonly [number, number, number],
  decode: (
    q: { vertices: Float32Array; dequantScale: number; dequantHalf: number },
    vi: number,
  ) => [number, number, number] = dequantVertex,
): number {
  // Source lon/lat (radians).
  const [srcLon, srcLat] = mercatorToLonLatRad(mx, my)

  // Pack (quantize) then dequant + re-add the tile-centre component — the
  // full quantize→dequant round trip. `decode` selects f64 (encoder intent,
  // default) or f32 (true GPU VS arithmetic, dequantVertexF32).
  const quant = packECEFPolygonVertices([mx, my, 0], ecefCenter)
  const [ax, ay, az] = decode(quant, 0)
  const recX = ax + ecefCenter[0]
  const recY = ay + ecefCenter[1]
  const recZ = az + ecefCenter[2]

  // Inverse ECEF → lon/lat.
  const [recLon, recLat] = ecefToLonLatRad(recX, recY, recZ)

  return arcLengthM(srcLon, srcLat, recLon, recLat)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AC2c.1.1 packECEFPolygonVertices precision round-trip', () => {

  it('quantized stride-28 output: fid passes through unchanged at float slot 3', () => {
    const [lon_rad, lat_rad] = mercatorToLonLatRad(0, 0)
    const center = lonLatRadToECEF(lon_rad, lat_rad)
    const quant = packECEFPolygonVertices([0, 0, 42], center)
    // #398: stride 28 bytes = 7 floats per vertex; fid at float index 3.
    expect(quant.vertices.length).toBe(7)
    expect(quant.vertices[3]).toBe(42)
    expect(quant.dequantHalf).toBeGreaterThan(0)
    expect(quant.dequantScale).toBeGreaterThan(0)
  })

  it('no axis clamps: extreme residuals encode within [0, 0xFFFF] per lane (no overflow)', () => {
    // Two verts: one near the +max residual, one near the -max. halfRange =
    // exact max-abs over the verts (+ epsilon) so by construction every axis
    // stays inside the symmetric range — no encode clamps. Verify every u16
    // lane is a valid 16-bit value and the round-trip stays sub-mm.
    const ext = tileExtentM(15)
    const [tLon, tLat] = mercatorToLonLatRad(ext * 7, ext * 3)
    const center = lonLatRadToECEF(tLon, tLat)
    const pv = [ext * 7 + ext * 0.5, ext * 3 + ext * 0.5, 0,
                ext * 7 - ext * 0.5, ext * 3 - ext * 0.5, 1]
    const quant = packECEFPolygonVertices(pv, center)
    const u16 = new Uint16Array(quant.vertices.buffer)
    // #398: stride is now 14 u16/vert (28 B). The 6 position lanes (0..5) of
    // each vertex must be valid 16-bit values; the f32 tail lanes are not
    // position and not checked here.
    const U16_PER_VERT = 14
    for (let vi = 0; vi < 2; vi++) {
      for (let lane = 0; lane < 6; lane++) {
        const v = u16[vi * U16_PER_VERT + lane]!
        expect(v >= 0 && v <= 0xFFFF).toBe(true)
      }
    }
    // Round-trip both verts: sub-mm.
    for (let vi = 0; vi < 2; vi++) {
      const [ax, ay, az] = dequantVertex(quant, vi)
      const mxRef = pv[vi * 3], myRef = pv[vi * 3 + 1]
      const [refLon, refLat] = mercatorToLonLatRad(mxRef, myRef)
      const [recLon, recLat] = ecefToLonLatRad(ax + center[0], ay + center[1], az + center[2])
      expect(arcLengthM(refLon, refLat, recLon, recLat)).toBeLessThan(1e-3)
    }
  })

  it('single known point: Tokyo at z=15, reconstruction ≤ 1 mm', () => {
    // Tokyo approx: lon=139.7°, lat=35.68°
    const lon = 139.7 * DEG2RAD
    const lat = 35.68 * DEG2RAD
    const mx = A * lon
    const my = A * Math.log(Math.tan(Math.PI / 4 + lat / 2))

    // Tile corner is close (within one tile extent at z=15).
    const ext = tileExtentM(15)
    const tileMx = mx - ext * 0.3
    const tileMy = my - ext * 0.2
    const [tLon, tLat] = mercatorToLonLatRad(tileMx, tileMy)
    const center = lonLatRadToECEF(tLon, tLat)

    const err = roundTripError(mx, my, center)
    expect(err).toBeLessThan(1e-3)  // 1 mm
  })

  it('1e4 random points — z=22: worst-case ≤ 1 mm', () => {
    const rng = makeRng(0x2c_1a)
    const ext = tileExtentM(22)
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    let worst = 0

    for (let i = 0; i < 10_000; i++) {
      // Tile corner strictly inside valid Mercator range so vertex ±ext stays valid.
      const baseMx = (rng() * 2 - 1) * (MX_MAX - ext)
      const baseMy = (rng() * 2 - 1) * (MY_MAX - ext)
      // Vertex within ±1 tile extent of the corner.
      const mx = baseMx + (rng() * 2 - 1) * ext
      const my = baseMy + (rng() * 2 - 1) * ext

      const [tLon, tLat] = mercatorToLonLatRad(baseMx, baseMy)
      const center = lonLatRadToECEF(tLon, tLat)

      const err = roundTripError(mx, my, center)
      if (err > worst) worst = err
    }

    // Report worst observed for diagnostics.
    console.log(`[z=22] worst reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-3)   // 1 mm
  })

  it('1e4 random points — z=15: worst-case ≤ 1 mm', () => {
    const rng = makeRng(0x2c_15)
    const ext = tileExtentM(15)
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    let worst = 0

    for (let i = 0; i < 10_000; i++) {
      // Tile corner strictly inside valid Mercator range so vertex ±ext stays valid.
      const baseMx = (rng() * 2 - 1) * (MX_MAX - ext)
      const baseMy = (rng() * 2 - 1) * (MY_MAX - ext)
      const mx = baseMx + (rng() * 2 - 1) * ext
      const my = baseMy + (rng() * 2 - 1) * ext

      const [tLon, tLat] = mercatorToLonLatRad(baseMx, baseMy)
      const center = lonLatRadToECEF(tLon, tLat)

      const err = roundTripError(mx, my, center)
      if (err > worst) worst = err
    }

    console.log(`[z=15] worst reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-3)   // 1 mm
  })

  it('1e4 random points — z=8: worst-case ≤ 1 cm', () => {
    const rng = makeRng(0x2c_08)
    const ext = tileExtentM(8)
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    let worst = 0

    for (let i = 0; i < 10_000; i++) {
      const baseMx = (rng() * 2 - 1) * (MX_MAX - ext)
      const baseMy = (rng() * 2 - 1) * (MY_MAX - ext)
      const mx = baseMx + (rng() * 2 - 1) * ext
      const my = baseMy + (rng() * 2 - 1) * ext

      const [tLon, tLat] = mercatorToLonLatRad(baseMx, baseMy)
      const center = lonLatRadToECEF(tLon, tLat)

      const err = roundTripError(mx, my, center)
      if (err > worst) worst = err
    }

    console.log(`[z=8] worst reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-2)   // 1 cm
  })

  it('1e4 random points — z=0: worst-case ≤ 1 cm', () => {
    const rng = makeRng(0x2c_00)
    // At z=0 the whole world is one tile (~40Mm wide). Pick a tile center
    // near the origin and scatter vertices within ±quarter-world of it.
    // The ECEF-RTC residual at z=0 can be large (up to ~10Mm) — the
    // f32 high half covers that, and lo corrects the f32 error term.
    // We test reconstruction is still ≤ 1 cm globally.
    const HALF = Math.PI * A * 0.4   // ±40% world extent as scatter radius
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    let worst = 0

    for (let i = 0; i < 10_000; i++) {
      // Tile center = random point inside valid bounds.
      const baseMx = (rng() * 2 - 1) * MX_MAX * 0.5
      const baseMy = (rng() * 2 - 1) * MY_MAX * 0.5
      // Vertex within ±HALF of center, clamped to valid range.
      const mx = Math.max(-MX_MAX, Math.min(MX_MAX,
        baseMx + (rng() * 2 - 1) * HALF))
      const my = Math.max(-MY_MAX, Math.min(MY_MAX,
        baseMy + (rng() * 2 - 1) * HALF))

      const [tLon, tLat] = mercatorToLonLatRad(baseMx, baseMy)
      const center = lonLatRadToECEF(tLon, tLat)

      const err = roundTripError(mx, my, center)
      if (err > worst) worst = err
    }

    console.log(`[z=0] worst reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-2)   // 1 cm
  })

  it('AC2c.2.3 local_merc round-trip: tile-local Mercator slots reconstruct absolute Mercator to < 1 mm', () => {
    // The f32 tail slots now carry TILE-LOCAL Mercator (mx − tileOriginMerc),
    // NOT absolute lon/lat degrees. The flat-Mercator fill VS positions from
    // these directly (rel = local_merc − cam), so they must reconstruct the
    // absolute Mercator to sub-mm at EVERY zoom — the precision the absolute-
    // degree slots lacked (~1.35 m at |lon|≈127° → ~10 px over-zoom split that
    // displaced the fill from its outline).
    const A_local = 6378137
    const MX_MAX = Math.PI * A_local
    const MY_MAX = Math.PI * A_local * 0.85  // ~±85.0511°
    const rng = makeRng(0x2c_2a)
    let worst = 0

    for (let i = 0; i < 10_000; i++) {
      // A realistic deep-zoom tile origin + a vertex within ~one z14 tile of it.
      const originMx = (rng() * 2 - 1) * MX_MAX * 0.98
      const originMy = (rng() * 2 - 1) * MY_MAX * 0.98
      const mx = originMx + (rng() * 2 - 1) * 2500  // ≤ ~2.5 km tile extent
      const my = originMy + (rng() * 2 - 1) * 2500

      const [tLon, tLat] = mercatorToLonLatRad(0, 0)
      const center = lonLatRadToECEF(tLon, tLat)
      const quant = packECEFPolygonVertices([mx, my, 0], center, [originMx, originMy])

      // local_merc at float slots 4 / 5 (stride-6). origin(f64) + slot(f32) = abs mx.
      const reconMx = originMx + (quant.vertices[4]! as number)
      const reconMy = originMy + (quant.vertices[5]! as number)
      worst = Math.max(worst, Math.abs(reconMx - mx), Math.abs(reconMy - my))
    }

    console.log(`[local_merc] worst reconstruction error: ${worst.toExponential(3)} m`)
    // Single f32 at ≤ tile-extent magnitude (~2.5 km) → ulp ~3e-4 m, so the
    // f64-origin + f32-slot reconstruction is sub-mm. The renderer's DSFUN
    // cam_h/cam_l cancel the origin in the live position path identically.
    expect(worst).toBeLessThan(1e-3)  // < 1 mm at every zoom
  })

  it('DSFUN beats naive single-f32 at z=22 (the whole point)', () => {
    // A vertex deep inside a tile: absolute ECEF ~6.4e6 m, tile-local ~few m.
    // Naive f32: store absolute ECEF axis as f32, reconstruct abs-center.
    // DSFUN: hi+lo reconstruct sub-mm.
    const lon = 0.1 * DEG2RAD  // near-equator, round numbers
    const lat = 0.1 * DEG2RAD
    const mx = A * lon
    const my = A * Math.log(Math.tan(Math.PI / 4 + lat / 2))

    const ext = tileExtentM(22)
    const tileMx = mx - ext * 0.3
    const tileMy = my - ext * 0.2
    const [tLon, tLat] = mercatorToLonLatRad(tileMx, tileMy)
    const center = lonLatRadToECEF(tLon, tLat)

    // DSFUN error.
    const dsfunErr = roundTripError(mx, my, center)

    // Naive error: store just ex (no hi/lo split) and reconstruct.
    const [sLon, sLat] = mercatorToLonLatRad(mx, my)
    const [ex, ey, ez] = lonLatRadToECEF(sLon, sLat)
    const naiveX = Math.fround(ex) - center[0]
    const naiveY = Math.fround(ey) - center[1]
    const naiveZ = Math.fround(ez) - center[2]
    const [naiveLon, naiveLat] = ecefToLonLatRad(
      naiveX + center[0], naiveY + center[1], naiveZ + center[2])
    const naiveErr = arcLengthM(sLon, sLat, naiveLon, naiveLat)

    expect(dsfunErr).toBeLessThanOrEqual(naiveErr)
    expect(dsfunErr).toBeLessThan(1e-3)  // sub-mm absolute
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GPU f32 reconstruction precision (the HONEST shader-side gate)
//
// The block above decodes in f64 — it measures the quantization grid error
// alone. The GPU VS reconstructs in f32 (`q = f32(hi)*65536 + f32(lo);
// axis = q*scale - half`), and because q reaches ~2^32 (far past f32's 2^24
// exact-integer limit), the low u16 lane's bits are largely swallowed. The
// real end-to-end precision is therefore MUCH coarser at low zoom than the
// f64 path reports. We pin the true f32 bounds here so the gate doesn't lie.
//
// Why this is acceptable (decision: keep 2f, honest gate):
//   • Screen-invisible: at z=0 the ~1.6 m error is ~2.5e-7 of the 6378 km
//     earth radius — far below a pixel at any practical zoom. High zoom
//     (z=22, where vertices are screen-large) stays at ~1 µm.
//   • Not a 2f regression: the pre-2f stride-9 DSFUN `pos_h + pos_l` recon
//     has the same in-shader f32 ceiling (z=0 ~0.4 m). An f32 ECEF VS cannot
//     do better; this is the format's GPU reality, not a quantization bug.
// ─────────────────────────────────────────────────────────────────────────────

describe('PR 2f — GPU f32 in-shader dequant precision (true shader-side bounds)', () => {
  // Worst-case f32 reconstruction per zoom, measured over 1e4 random points.
  // Bounds reflect the GPU's actual arithmetic (validated screen-invisible),
  // NOT the optimistic f64 quantization-only error.
  const cases: ReadonlyArray<{ z: number; seed: number; boundM: number }> = [
    { z: 22, seed: 0x2f_22, boundM: 1e-5 },   // ~1 µm — high zoom, near-perfect
    { z: 15, seed: 0x2f_15, boundM: 1e-3 },   // sub-mm
    { z: 8,  seed: 0x2f_08, boundM: 5e-2 },   // ~2 cm — coarsened by f32
    { z: 0,  seed: 0x2f_00, boundM: 3.0 },    // ~1.6 m — screen-invisible (2.5e-7 of R)
  ]

  for (const { z, seed, boundM } of cases) {
    it(`1e4 random points — z=${z}: f32 shader reconstruction ≤ ${boundM} m`, () => {
      const rng = makeRng(seed)
      const ext = tileExtentM(z)
      const MX_MAX = Math.PI * A
      const MY_MAX = Math.PI * A * 0.85
      // z=0 spans the whole world in one tile; scatter within ±40% world.
      const scatter = z === 0 ? Math.PI * A * 0.4 : ext
      let worst = 0
      for (let i = 0; i < 10_000; i++) {
        const baseMx = (rng() * 2 - 1) * (MX_MAX - scatter) * (z === 0 ? 0.5 : 1)
        const baseMy = (rng() * 2 - 1) * (MY_MAX - scatter) * (z === 0 ? 0.5 : 1)
        const mx = baseMx + (rng() * 2 - 1) * scatter
        const my = baseMy + (rng() * 2 - 1) * scatter
        const [tLon, tLat] = mercatorToLonLatRad(baseMx, baseMy)
        const center = lonLatRadToECEF(tLon, tLat)
        const err = roundTripError(mx, my, center, dequantVertexF32)
        if (err > worst) worst = err
      }
      console.log(`[z=${z}] worst f32 SHADER reconstruction: ${worst.toExponential(4)} m`)
      expect(worst).toBeLessThan(boundM)
    })
  }
})
