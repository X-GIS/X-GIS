// Phase 2 PR 2d.1 Spike 1 — packECEFLineSegments precision fuzz test.
//
// Round-trip precision gate for packECEFLineSegments:
//   Mercator (mx, my) → pack stride-8 → reconstruct ECEF f64 → inverse to
//   lon/lat → compare to source lon/lat derived from (mx, my).
//
// GPU reconstruction: ex_f64 = f64(ex_h) + f64(ex_l) + ecefTileCenter[0].
// Inverse ECEF → lon/lat via Bowring iteration (mirrors ecef.ts:45-64).
//
// Precision gates (per planner AC2d.2.5 mirror of AC2c.1.1):
//   z=22 — ≤ 1 mm arc-length on the ellipsoid surface
//   z=15 — ≤ 1 mm
//   z=8  — ≤ 1 cm
//   z=0  — ≤ 1 cm
//
// Passthrough checks:
//   - abs_lon/abs_lat at output stride indices 6+7 match Mercator inverse
//     to < 1e-5 degrees (mirrors AC2c.2.3 polygon test tolerance).
//   - DSFUN reconstruction sanity: hi + lo + center ≈ source ECEF within
//     Float32 epsilon (proven via the arc-length round-trip gate itself).

import { describe, it, expect } from 'vitest'
import { packECEFLineSegments } from './vector-tiler'

// ── WGS84 constants (mirrors runtime/src/engine/projection/ecef.ts) ─────────
const A = 6378137               // semi-major axis (m)
const F = 1 / 298.257223563
const E2 = F * (2 - F)          // first eccentricity squared
const DEG2RAD = Math.PI / 180

// ── Deterministic LCG RNG (same shape as ecef-precision-fuzz.test.ts) ───────
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

// ── Build a stride-8 line-vertex scratch buffer with one endpoint ────────────
//
// packECEFLineSegments reads stride-8 input. We fill (mx, my) and zero the
// per-endpoint scalars (featId, arc, tangents) — none are carried in the
// spike's output. Spike 2 will validate carry behaviour.
function buildScratch(mx: number, my: number): number[] {
  return [mx, my, 0, 0, 0, 0, 0, 0]
}

// ── Core helper: pack one endpoint and measure reconstruction error ─────────

function roundTripError(
  mx: number,
  my: number,
  ecefCenter: readonly [number, number, number],
): number {
  // Source lon/lat (radians).
  const [srcLon, srcLat] = mercatorToLonLatRad(mx, my)

  // Pack.
  const packed = packECEFLineSegments(buildScratch(mx, my), ecefCenter)

  // GPU reconstruction: f64 hi + f64 lo + tile-center component.
  const recX = (packed[0]! as number) + (packed[3]! as number) + ecefCenter[0]
  const recY = (packed[1]! as number) + (packed[4]! as number) + ecefCenter[1]
  const recZ = (packed[2]! as number) + (packed[5]! as number) + ecefCenter[2]

  // Inverse ECEF → lon/lat.
  const [recLon, recLat] = ecefToLonLatRad(recX, recY, recZ)

  return arcLengthM(srcLon, srcLat, recLon, recLat)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PR 2d.1 Spike 1 — packECEFLineSegments precision round-trip', () => {

  it('stride-8 output: shape matches one entry per endpoint', () => {
    const [lon_rad, lat_rad] = mercatorToLonLatRad(0, 0)
    const center = lonLatRadToECEF(lon_rad, lat_rad)
    // Two endpoints, each stride 8 in.
    const scratch = [
      ...buildScratch(0, 0),
      ...buildScratch(1000, 1000),
    ]
    const packed = packECEFLineSegments(scratch, center)
    expect(packed.length).toBe(16)  // 2 endpoints × stride 8
  })

  it('single known endpoint: Tokyo at z=15, reconstruction ≤ 1 mm', () => {
    const lon = 139.7 * DEG2RAD
    const lat = 35.68 * DEG2RAD
    const mx = A * lon
    const my = A * Math.log(Math.tan(Math.PI / 4 + lat / 2))

    const ext = tileExtentM(15)
    const tileMx = mx - ext * 0.3
    const tileMy = my - ext * 0.2
    const [tLon, tLat] = mercatorToLonLatRad(tileMx, tileMy)
    const center = lonLatRadToECEF(tLon, tLat)

    const err = roundTripError(mx, my, center)
    expect(err).toBeLessThan(1e-3)  // 1 mm
  })

  it('1e4 random endpoints — z=22: worst-case ≤ 1 mm', () => {
    const rng = makeRng(0x2d_22)
    const ext = tileExtentM(22)
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

    console.log(`[z=22] worst reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-3)   // 1 mm
  })

  it('1e4 random endpoints — z=15: worst-case ≤ 1 mm', () => {
    const rng = makeRng(0x2d_15)
    const ext = tileExtentM(15)
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

    console.log(`[z=15] worst reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-3)   // 1 mm
  })

  it('1e4 random endpoints — z=8: worst-case ≤ 1 cm', () => {
    const rng = makeRng(0x2d_08)
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

  it('1e4 random endpoints — z=0: worst-case ≤ 1 cm', () => {
    const rng = makeRng(0x2d_00)
    const HALF = Math.PI * A * 0.4
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    let worst = 0

    for (let i = 0; i < 10_000; i++) {
      const baseMx = (rng() * 2 - 1) * MX_MAX * 0.5
      const baseMy = (rng() * 2 - 1) * MY_MAX * 0.5
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

  it('abs_lon/abs_lat passthrough: 1e4 endpoints match Mercator inverse to < 1e-5 degrees', () => {
    const RAD2DEG = 180 / Math.PI
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    const rng = makeRng(0x2d_2a)
    let worstLon = 0
    let worstLat = 0

    for (let i = 0; i < 10_000; i++) {
      const mx = (rng() * 2 - 1) * MX_MAX
      const my = (rng() * 2 - 1) * MY_MAX

      const ref_lon_rad = mx / A
      const ref_lat_rad = 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2
      const ref_lon_deg = ref_lon_rad * RAD2DEG
      const ref_lat_deg = ref_lat_rad * RAD2DEG

      const [tLon, tLat] = mercatorToLonLatRad(0, 0)
      const center = lonLatRadToECEF(tLon, tLat)

      const packed = packECEFLineSegments(buildScratch(mx, my), center)

      // abs_lon at index 6, abs_lat at index 7.
      const packed_lon_deg = packed[6]! as number
      const packed_lat_deg = packed[7]! as number

      const dLon = Math.abs(packed_lon_deg - ref_lon_deg)
      const dLat = Math.abs(packed_lat_deg - ref_lat_deg)
      if (dLon > worstLon) worstLon = dLon
      if (dLat > worstLat) worstLat = dLat

      // Range assertions.
      expect(packed_lon_deg).toBeGreaterThan(-180)
      expect(packed_lon_deg).toBeLessThanOrEqual(180)
      expect(packed_lat_deg).toBeGreaterThanOrEqual(-85.0511)
      expect(packed_lat_deg).toBeLessThanOrEqual(85.0511)
    }

    console.log(`[abs_lon/abs_lat] worst delta: lon=${worstLon.toExponential(3)}°  lat=${worstLat.toExponential(3)}°`)
    expect(worstLon).toBeLessThan(1e-5)
    expect(worstLat).toBeLessThan(1e-5)
  })

  it('multi-endpoint batch: stride alignment preserved across N endpoints', () => {
    // Pack 100 endpoints in a single call, verify each round-trips
    // independently — proves the inner loop's index arithmetic doesn't drift.
    const rng = makeRng(0x2d_b1)
    const ext = tileExtentM(15)
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    const baseMx = (rng() * 2 - 1) * (MX_MAX - ext)
    const baseMy = (rng() * 2 - 1) * (MY_MAX - ext)
    const [tLon, tLat] = mercatorToLonLatRad(baseMx, baseMy)
    const center = lonLatRadToECEF(tLon, tLat)

    const N = 100
    const scratch: number[] = []
    const ref: Array<[number, number]> = []
    for (let i = 0; i < N; i++) {
      const mx = baseMx + (rng() * 2 - 1) * ext
      const my = baseMy + (rng() * 2 - 1) * ext
      scratch.push(...buildScratch(mx, my))
      ref.push([mx, my])
    }
    const packed = packECEFLineSegments(scratch, center)
    expect(packed.length).toBe(N * 8)

    let worst = 0
    for (let i = 0; i < N; i++) {
      const [mx, my] = ref[i]
      const [srcLon, srcLat] = mercatorToLonLatRad(mx, my)
      const di = i * 8
      const recX = packed[di]! + packed[di + 3]! + center[0]
      const recY = packed[di + 1]! + packed[di + 4]! + center[1]
      const recZ = packed[di + 2]! + packed[di + 5]! + center[2]
      const [recLon, recLat] = ecefToLonLatRad(recX, recY, recZ)
      const err = arcLengthM(srcLon, srcLat, recLon, recLat)
      if (err > worst) worst = err
    }
    expect(worst).toBeLessThan(1e-3)  // 1 mm at z=15
  })
})
