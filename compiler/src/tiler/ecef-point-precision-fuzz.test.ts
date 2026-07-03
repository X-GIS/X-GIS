// Phase 2 PR 2d.2 — AC2d.2.5 verification.
//
// Round-trip precision gate for packECEFPointFeatures (the point-VS sibling
// of packECEFPolygonVertices). Identical math + output layout to the polygon
// packer, but exercised through the named export the point path uses so a
// future divergence between point and polygon packers (e.g. if one is
// inlined and the other isn't) gets caught.
//
//   Mercator (mx, my) → pack stride-9 → reconstruct ECEF f64 → inverse to
//   lon/lat → compare to source lon/lat derived from (mx, my).
//
// Precision gates:
//   z=22 — ≤ 1 mm arc-length on the ellipsoid surface
//   z=15 — ≤ 1 mm
//   z=8  — ≤ 1 cm
//   z=0  — ≤ 1 cm

import { describe, it, expect } from 'vitest'
import { packECEFPointFeatures } from './ecef-packing'

// ── WGS84 constants (mirrors runtime/src/engine/projection/ecef.ts) ─────────
const A = 6378137 // semi-major axis (m)
const F = 1 / 298.257223563
const E2 = F * (2 - F) // first eccentricity squared

// ── Deterministic LCG RNG ────────────────────────────────────────────────────
function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13
    s |= 0
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return (s >>> 0) / 0x1_0000_0000
  }
}

// ── Coordinate helpers (all inlined — no cross-package imports) ──────────────

function mercatorToLonLatRad(mx: number, my: number): [number, number] {
  return [mx / A, 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2]
}

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
    if (Math.abs(newLat - lat) < 1e-12) {
      lat = newLat
      break
    }
    lat = newLat
  }
  return [lon, lat]
}

function arcLengthM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLon = (lon2 - lon1) * Math.cos((lat1 + lat2) / 2)
  const dLat = lat2 - lat1
  return A * Math.hypot(dLon, dLat)
}

function tileExtentM(z: number): number {
  return (2 * Math.PI * A) / Math.pow(2, z)
}

// Camera-relative RTC fix: packECEFPointFeatures now emits ABSOLUTE ECEF
// DSFUN (no per-tile center), so reconstruction is hi + lo with no center
// add-back. DSFUN keeps ~30 nm precision even at the ~6.4e6 m absolute scale,
// so the sub-mm gates below still hold.
function roundTripError(mx: number, my: number): number {
  const [srcLon, srcLat] = mercatorToLonLatRad(mx, my)
  const packed = packECEFPointFeatures([mx, my, 0])
  const recX = (packed[0]! as number) + (packed[3]! as number)
  const recY = (packed[1]! as number) + (packed[4]! as number)
  const recZ = (packed[2]! as number) + (packed[5]! as number)
  const [recLon, recLat] = ecefToLonLatRad(recX, recY, recZ)
  return arcLengthM(srcLon, srcLat, recLon, recLat)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AC2d.2.5 packECEFPointFeatures precision round-trip', () => {
  it('stride-13 output: fid passes through unchanged', () => {
    const packed = packECEFPointFeatures([0, 0, 42])
    expect(packed.length).toBe(13)
    expect(packed[6]).toBe(42)
  })

  // The flat-Mercator point/icon/label VS reads the absolute Mercator DSFUN
  // tail (slots 9-12) instead of reprojecting the lossy f32 abs_lon/abs_lat.
  // mx_h + mx_l must reconstruct the input Mercator to sub-mm at every zoom,
  // AND the f32-degree path it replaces must be materially worse (proving the
  // tail is necessary). Fails before the fix (slots 9-12 didn't exist).
  it('abs Mercator DSFUN tail (9-12) reconstructs sub-mm; beats the f32-degree path', () => {
    const DEG2RAD = Math.PI / 180
    const RAD2DEG = 180 / Math.PI
    const rng = makeRng(0x2d_dd)
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    let worstDsfun = 0
    let worstLossy = 0
    for (let i = 0; i < 10_000; i++) {
      const mx = (rng() * 2 - 1) * MX_MAX
      const my = (rng() * 2 - 1) * MY_MAX
      const packed = packECEFPointFeatures([mx, my, 0])
      // DSFUN tail reconstruction.
      const recMx = (packed[9]! as number) + (packed[10]! as number)
      const recMy = (packed[11]! as number) + (packed[12]! as number)
      worstDsfun = Math.max(worstDsfun, Math.hypot(recMx - mx, recMy - my))
      // Lossy path the VS USED to take: f32 abs_lon/abs_lat (7/8) → Mercator.
      const lossyMx = (packed[7]! as number) * DEG2RAD * A
      const latRad = (packed[8]! as number) * DEG2RAD
      const lossyMy = Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * A
      worstLossy = Math.max(worstLossy, Math.hypot(lossyMx - mx, lossyMy - my))
      // silence unused RAD2DEG lint when the body shrinks
      void RAD2DEG
    }
    console.log(
      `[merc DSFUN tail] worst: dsfun=${(worstDsfun * 1000).toFixed(6)} mm  lossy=${worstLossy.toFixed(3)} m`,
    )
    expect(worstDsfun).toBeLessThan(1e-3) // sub-mm
    expect(worstLossy).toBeGreaterThan(0.1) // the f32-degree path loses >10 cm
  })

  it('1e4 random points — z=22: worst-case ≤ 1 mm', () => {
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

      const err = roundTripError(mx, my)
      if (err > worst) worst = err
    }

    console.log(`[z=22] worst point reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-3) // 1 mm
  })

  it('1e4 random points — z=15: worst-case ≤ 1 mm', () => {
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

      const err = roundTripError(mx, my)
      if (err > worst) worst = err
    }

    console.log(`[z=15] worst point reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-3)
  })

  it('1e4 random points — z=8: worst-case ≤ 1 cm', () => {
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

      const err = roundTripError(mx, my)
      if (err > worst) worst = err
    }

    console.log(`[z=8] worst point reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-2)
  })

  it('1e4 random points — z=0: worst-case ≤ 1 cm', () => {
    const rng = makeRng(0x2d_00)
    const HALF = Math.PI * A * 0.4
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    let worst = 0

    for (let i = 0; i < 10_000; i++) {
      const baseMx = (rng() * 2 - 1) * MX_MAX * 0.5
      const baseMy = (rng() * 2 - 1) * MY_MAX * 0.5
      const mx = Math.max(-MX_MAX, Math.min(MX_MAX, baseMx + (rng() * 2 - 1) * HALF))
      const my = Math.max(-MY_MAX, Math.min(MY_MAX, baseMy + (rng() * 2 - 1) * HALF))

      const err = roundTripError(mx, my)
      if (err > worst) worst = err
    }

    console.log(`[z=0] worst point reconstruction error: ${(worst * 1000).toFixed(6)} mm`)
    expect(worst).toBeLessThan(1e-2)
  })

  it('abs_lon/abs_lat at indices 7+8 match Mercator inverse to < 1e-5°', () => {
    const RAD2DEG = 180 / Math.PI
    const MX_MAX = Math.PI * A
    const MY_MAX = Math.PI * A * 0.85
    const rng = makeRng(0x2d_aa)
    let worstLon = 0
    let worstLat = 0

    for (let i = 0; i < 10_000; i++) {
      const mx = (rng() * 2 - 1) * MX_MAX
      const my = (rng() * 2 - 1) * MY_MAX

      const ref_lon_rad = mx / A
      const ref_lat_rad = 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2
      const ref_lon_deg = ref_lon_rad * RAD2DEG
      const ref_lat_deg = ref_lat_rad * RAD2DEG

      const packed = packECEFPointFeatures([mx, my, 0])

      const packed_lon_deg = packed[7]! as number
      const packed_lat_deg = packed[8]! as number

      const dLon = Math.abs(packed_lon_deg - ref_lon_deg)
      const dLat = Math.abs(packed_lat_deg - ref_lat_deg)
      if (dLon > worstLon) worstLon = dLon
      if (dLat > worstLat) worstLat = dLat
    }

    console.log(
      `[point abs_lon/abs_lat] worst delta: lon=${worstLon.toExponential(3)}°  lat=${worstLat.toExponential(3)}°`,
    )
    expect(worstLon).toBeLessThan(1e-5)
    expect(worstLat).toBeLessThan(1e-5)
  })
})
